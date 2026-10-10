// Sound presets, each synthesized live with Tone.js.
//
// A preset's build(sound) function creates its nodes through the Sound helper,
// which tracks them so the whole preset can be started, stopped and disposed
// as one. Everything a preset produces goes into sound.out.

const FADE_TIME = 0.1;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class Sound {
    constructor(destination, level = 0) {
        this.sources = []; // started and stopped with the sound (noise, oscillators, LFOs)
        this.loops = [];   // Transport loops that schedule random events
        this.nodes = [];   // everything, for dispose()

        // Each preset has its own fade gate so presets can crossfade
        this.gate = new Tone.Gain(0).connect(destination);
        this.out = this.add(new Tone.Volume(level)).connect(this.gate);
    }

    add(node) {
        this.nodes.push(node);
        return node;
    }

    source(node) {
        this.sources.push(node);
        return this.add(node);
    }

    // Run callback(time) every `interval` seconds, with the given probability
    every(interval, callback, probability = 1) {
        const loop = new Tone.Loop(callback, interval);
        loop.probability = probability;
        this.loops.push(loop);
        return this.add(loop);
    }

    // Two independent noise sources panned apart, for a wide stereo image
    stereoNoise(type, width = 0.7) {
        const out = this.add(new Tone.Gain(0.7));
        for (const pan of [-width, width]) {
            this.source(new Tone.Noise(type)).chain(this.add(new Tone.Panner(pan)), out);
        }
        return out;
    }

    // Round-robin pool of voices so short events can overlap
    voices(count, create) {
        const pool = Array.from({ length: count }, create);
        let index = 0;
        return () => pool[index++ % count];
    }

    start() {
        const now = Tone.now();
        this.gate.gain.rampTo(1, FADE_TIME, now);
        this.sources.forEach(source => source.start(now));
        this.loops.forEach(loop => loop.start());
    }

    stop() {
        const now = Tone.now();
        this.gate.gain.rampTo(0, FADE_TIME, now);
        this.sources.forEach(source => source.stop(now + FADE_TIME));
        this.loops.forEach(loop => loop.stop());
    }

    dispose() {
        this.nodes.forEach(node => node.dispose());
        this.gate.dispose();
    }
}

// Building blocks shared by several presets

function plainNoise(type) {
    return sound => {
        sound.source(new Tone.Noise(type)).connect(sound.out);
    };
}

// A short burst of filtered noise at a random pitch and position (raindrop
// patter, fire crackle). Returns trigger(time, velocity, minFreq, maxFreq, decay).
function noiseBursts(sound, output) {
    const panner = sound.add(new Tone.Panner()).connect(output);
    const bandpass = sound.add(new Tone.Filter({ type: 'bandpass', Q: 1.5 })).connect(panner);
    const synth = sound.add(new Tone.NoiseSynth({
        noise: { type: 'white' },
        envelope: { attack: 0.001, decay: 0.02, sustain: 0, release: 0.01 }
    })).connect(bandpass);

    // A single synth can't schedule events out of order, so clusters that run
    // past the next loop tick get nudged later
    let lastTime = 0;
    return (time, velocity, minFreq, maxFreq, decay) => {
        time = Math.max(time, lastTime + 0.002);
        lastTime = time;
        bandpass.frequency.setValueAtTime(Math.exp(rand(Math.log(minFreq), Math.log(maxFreq))), time);
        panner.pan.setValueAtTime(rand(-0.9, 0.9), time);
        synth.envelope.decay = decay;
        synth.triggerAttackRelease(decay, time, velocity);
    };
}

// A sine blip whose pitch rises quickly, like a drop hitting water or a bubble
// surfacing. Returns trigger(time, velocity, minFreq, maxFreq).
function bubbles(sound, output, voiceCount = 4) {
    const next = sound.voices(voiceCount, () => {
        const panner = sound.add(new Tone.Panner()).connect(output);
        const synth = sound.add(new Tone.Synth({
            oscillator: { type: 'sine' },
            envelope: { attack: 0.002, decay: 0.06, sustain: 0, release: 0.02 }
        })).connect(panner);
        return { synth, panner };
    });

    return (time, velocity, minFreq, maxFreq) => {
        const { synth, panner } = next();
        const freq = rand(minFreq, maxFreq);
        panner.pan.setValueAtTime(rand(-0.8, 0.8), time);
        synth.triggerAttackRelease(freq, 0.04, time, velocity);
        synth.frequency.exponentialRampToValueAtTime(freq * rand(1.4, 2.2), time + 0.05);
    };
}

function rainLayer(sound, { bedLevel, patterRate, plinkRate }) {
    // Steady wash of distant drops
    const bed = sound.add(new Tone.Gain(bedLevel)).connect(sound.out);
    sound.stereoNoise('pink').chain(
        sound.add(new Tone.Filter({ type: 'highpass', frequency: 400 })),
        sound.add(new Tone.Filter({ type: 'lowpass', frequency: 7000, Q: 0.5 })),
        bed
    );

    // Individual drops close by
    const patter = noiseBursts(sound, sound.out);
    sound.every(0.01, time => patter(time + rand(0, 0.01), rand(0.05, 0.4), 1500, 8000, rand(0.008, 0.03)), patterRate / 100);

    const plink = bubbles(sound, sound.add(new Tone.Gain(0.15)).connect(sound.out));
    sound.every(0.05, time => plink(time + rand(0, 0.05), rand(0.3, 1), 1500, 4000), plinkRate / 20);
}

// Presets

function buildRain(sound) {
    rainLayer(sound, { bedLevel: 0.5, patterRate: 40, plinkRate: 2 });
}

function buildStorm(sound) {
    rainLayer(sound, { bedLevel: 0.8, patterRate: 70, plinkRate: 3 });

    // Thunder: a brown-noise rumble shaped by a few random swells, brighter
    // and sharper when close, duller and slower when distant
    const lowpass = sound.add(new Tone.Filter({ type: 'lowpass', frequency: 200, Q: 0.7 }));
    const level = sound.add(new Tone.Gain(0));
    sound.source(new Tone.Noise('brown')).chain(lowpass, level, sound.out);

    let nextThunder = rand(3, 10);
    sound.every(1, time => {
        if (time < nextThunder) {
            return;
        }
        const distance = Math.random(); // 0 = overhead, 1 = far away
        const peak = 1.2 - 0.9 * distance;
        let t = time + rand(0, 1);

        lowpass.frequency.cancelScheduledValues(t);
        lowpass.frequency.setValueAtTime(900 - 600 * distance, t);
        lowpass.frequency.setTargetAtTime(120, t + 0.3, 2);

        level.gain.cancelScheduledValues(t);
        level.gain.setTargetAtTime(peak, t, 0.02 + 0.4 * distance);
        const swells = Math.floor(rand(2, 5));
        for (let i = 0; i < swells; i++) {
            t += rand(0.3, 1.2);
            level.gain.setTargetAtTime(peak * rand(0.3, 0.6), t, 0.3);
            t += rand(0.2, 0.6);
            level.gain.setTargetAtTime(peak * rand(0.5, 0.9), t, 0.1 + 0.3 * distance);
        }
        level.gain.setTargetAtTime(0, t + 0.5, rand(1.2, 2.5));

        nextThunder = t + rand(12, 35);
    });
}

function buildOcean(sound) {
    // Low, steady undertow so the gaps between waves aren't silent
    const undertow = sound.add(new Tone.Gain(0.15)).connect(sound.out);
    sound.stereoNoise('brown').chain(sound.add(new Tone.Filter({ type: 'lowpass', frequency: 300 })), undertow);

    // Two independent wave trains, one on each side, so waves overlap irregularly
    for (const pan of [-0.6, 0.6]) {
        const lowpass = sound.add(new Tone.Filter({ type: 'lowpass', frequency: 300, Q: 0.5 }));
        const level = sound.add(new Tone.Gain(0));
        sound.source(new Tone.Noise('pink')).chain(lowpass, level, sound.add(new Tone.Panner(pan)), sound.out);

        let nextWave = 0;
        sound.every(0.5, time => {
            if (time < nextWave) {
                return;
            }
            const rise = rand(2, 4);
            const size = rand(0.5, 1);
            // The wave builds, breaks, then washes back out
            level.gain.setTargetAtTime(size, time, rise / 3);
            lowpass.frequency.setTargetAtTime(800 + 2500 * size, time, rise / 3);
            level.gain.setTargetAtTime(0.05, time + rise, rand(1, 2));
            lowpass.frequency.setTargetAtTime(300, time + rise, rand(1.5, 2.5));
            nextWave = time + rise + rand(2, 6);
        });
    }
}

function buildWind(sound) {
    const bandpass = sound.add(new Tone.Filter({ type: 'bandpass', frequency: 500, Q: 0.8 }));
    const level = sound.add(new Tone.Gain(0.5));
    sound.stereoNoise('pink').chain(bandpass, level, sound.out);

    // Faint whistle through a narrow resonant filter, heard in strong gusts
    const whistleFilter = sound.add(new Tone.Filter({ type: 'bandpass', frequency: 900, Q: 25 }));
    const whistleLevel = sound.add(new Tone.Gain(0));
    sound.source(new Tone.Noise('white')).chain(whistleFilter, whistleLevel, sound.out);

    // Gust strength wanders randomly; pitch and loudness follow it
    let gust = 0.4;
    sound.every(0.5, time => {
        gust = clamp(gust + rand(-0.35, 0.35), 0, 1);
        const smoothing = rand(0.6, 2);
        level.gain.setTargetAtTime(0.25 + 0.75 * gust, time, smoothing);
        bandpass.frequency.setTargetAtTime(250 + 900 * gust, time, smoothing);
        whistleLevel.gain.setTargetAtTime(1.5 * gust ** 3, time, smoothing);
        whistleFilter.frequency.setTargetAtTime(700 + 800 * gust + rand(-50, 50), time, smoothing);
    }, 0.6);
}

function buildStream(sound) {
    // Broad rush of moving water
    const bed = sound.add(new Tone.Gain(0.35)).connect(sound.out);
    sound.stereoNoise('pink').chain(
        sound.add(new Tone.Filter({ type: 'highpass', frequency: 300 })),
        sound.add(new Tone.Filter({ type: 'lowpass', frequency: 4000 })),
        bed
    );

    // Babbling: resonant filters on noise, their pitch jumping around quickly
    const babble = [-0.6, -0.2, 0.2, 0.6].map(pan => {
        const filter = sound.add(new Tone.Filter({ type: 'bandpass', frequency: 800, Q: 6 }));
        const level = sound.add(new Tone.Gain(0.5));
        sound.source(new Tone.Noise('white')).chain(filter, level, sound.add(new Tone.Panner(pan)), sound.out);
        return { filter, level };
    });
    sound.every(0.04, time => {
        for (const { filter, level } of babble) {
            if (Math.random() < 0.5) {
                filter.frequency.setTargetAtTime(400 * 2 ** rand(0, 2.5), time, rand(0.005, 0.03));
                level.gain.setTargetAtTime(rand(0.2, 0.9), time, 0.02);
            }
        }
    });

    const bubble = bubbles(sound, sound.add(new Tone.Gain(0.12)).connect(sound.out), 6);
    sound.every(0.03, time => bubble(time + rand(0, 0.03), rand(0.3, 1), 400, 1400), 0.3);
}

function buildFan(sound) {
    // Low rumble of moving air
    const rumble = sound.add(new Tone.Gain(0.9)).connect(sound.out);
    sound.stereoNoise('brown').chain(sound.add(new Tone.Filter({ type: 'lowpass', frequency: 450, Q: 0.7 })), rumble);

    // Airy whoosh, pulsing gently with each blade pass
    const whoosh = sound.add(new Tone.Gain(0.15)).connect(sound.out);
    const bladePass = sound.source(new Tone.Tremolo({ frequency: 14, depth: 0.25, spread: 0 }));
    sound.source(new Tone.Noise('pink')).chain(
        sound.add(new Tone.Filter({ type: 'bandpass', frequency: 1200, Q: 0.6 })),
        bladePass,
        whoosh
    );

    // Motor hum
    const hum = sound.add(new Tone.Gain(0.02)).connect(sound.out);
    sound.source(new Tone.Oscillator(98, 'sine')).connect(hum);
    sound.source(new Tone.Oscillator(196, 'sine')).connect(sound.add(new Tone.Gain(0.4)).connect(hum));
}

function buildFire(sound) {
    // Low roar of the flames, flickering
    const roar = sound.add(new Tone.Gain(0.6));
    sound.stereoNoise('brown').chain(sound.add(new Tone.Filter({ type: 'lowpass', frequency: 250 })), roar, sound.out);
    sound.every(0.15, time => roar.gain.setTargetAtTime(rand(0.4, 1), time, 0.1));

    // Soft hiss of escaping gas
    const hiss = sound.add(new Tone.Gain(0.04)).connect(sound.out);
    sound.source(new Tone.Noise('pink')).chain(sound.add(new Tone.Filter({ type: 'highpass', frequency: 3000 })), hiss);

    // Crackles, often in quick clusters, and the occasional deeper pop
    const crackle = noiseBursts(sound, sound.add(new Tone.Gain(0.5)).connect(sound.out));
    sound.every(0.05, time => {
        if (Math.random() < 0.08) {
            crackle(time, rand(0.6, 1), 300, 1000, rand(0.03, 0.06));
            return;
        }
        const count = Math.random() < 0.3 ? Math.floor(rand(2, 6)) : 1;
        let t = time;
        for (let i = 0; i < count; i++) {
            crackle(t, rand(0.2, 1), 1500, 6000, rand(0.002, 0.015));
            t += rand(0.015, 0.05);
        }
    }, 0.25);
}

function buildNight(sound) {
    // Distant, soft air
    const air = sound.add(new Tone.Gain(0.25)).connect(sound.out);
    sound.stereoNoise('pink').chain(sound.add(new Tone.Filter({ type: 'lowpass', frequency: 500 })), air);

    // A few crickets, each with its own pitch, position and chirp rhythm
    const crickets = [
        { freq: 4300, pan: -0.6, interval: 0.63, pulses: 3, level: 0.05 },
        { freq: 4750, pan: 0.5, interval: 0.81, pulses: 4, level: 0.035 },
        { freq: 5100, pan: 0.05, interval: 1.13, pulses: 3, level: 0.02 }
    ];
    for (const cricket of crickets) {
        const level = sound.add(new Tone.Gain(0));
        sound.source(new Tone.Oscillator(cricket.freq, 'sine'))
            .chain(level, sound.add(new Tone.Panner(cricket.pan)), sound.out);
        sound.every(cricket.interval, time => {
            const t = time + rand(0, 0.04);
            for (let i = 0; i < cricket.pulses; i++) {
                const pulse = t + i * 0.045;
                level.gain.setTargetAtTime(cricket.level, pulse, 0.003);
                level.gain.setTargetAtTime(0, pulse + 0.02, 0.004);
            }
        }, 0.9);
    }
}

// level (dB) evens out loudness between presets: about -16 LUFS at full volume,
// measured from offline renders. Spiky presets (ocean, storm) sit a little lower
// to leave headroom for their peaks, and the crickets are quiet on purpose.
const SOUNDS = {
    white: { build: plainNoise('white'), level: -17.5 },
    pink: { build: plainNoise('pink'), level: -4.5 },
    brown: { build: plainNoise('brown'), level: -3.5 },
    rain: { build: buildRain, level: 8.5 },
    storm: { build: buildStorm, level: 1.5 },
    ocean: { build: buildOcean, level: 5 },
    wind: { build: buildWind, level: 7.5 },
    stream: { build: buildStream, level: 7 },
    fan: { build: buildFan, level: 4 },
    fire: { build: buildFire, level: 6.5 },
    night: { build: buildNight, level: 10 }
};

function createSound(id, destination) {
    const preset = SOUNDS[id];
    const sound = new Sound(destination, preset.level);
    preset.build(sound);
    return sound;
}
