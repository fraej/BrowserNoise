// Effects rack: the Tone.js effects, filters and dynamics processors, chained in
// series between the main filter and the volume control.
//
// EFFECTS describes each unit: how to create its Tone.js node and which of its
// parameters to expose. EffectUnit wraps a node with a dry/wet mix and a
// click-free bypass (Tone.js only gives its "effects" a wet control, not its
// filters or compressors). EffectChain wires the units in series and handles
// adding, removing and reordering them while audio is playing.

const RAMP_TIME = 0.05;
const MAX_EFFECTS = 20;

// Effects marked `worklet` run on AudioWorklets, which browsers won't load
// for a page opened straight from disk (file://)
const WORKLETS_AVAILABLE = location.protocol !== 'file:';

function isEffectAvailable(type) {
    return WORKLETS_AVAILABLE || !EFFECTS[type].worklet;
}

const WAVEFORMS = [
    { value: 'sine', label: 'Sine' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'square', label: 'Square' },
    { value: 'sawtooth', label: 'Saw' }
];

const OVERSAMPLING = [
    { value: 'none', label: 'Off' },
    { value: '2x', label: '2x' },
    { value: '4x', label: '4x' }
];

// Each effect may also set:
// - mix: the default dry/wet mix, or false for units where mixing makes no sense
// - level: makeup gain in dB on the wet signal (a number, or a function of the
//   params) for effects that come out much louder or quieter than they go in.
//   The curves were fitted to offline loudness measurements of pink noise.
// - update(node, params, smooth): applies all params at once, for effects whose
//   params depend on each other
//
// Parameter shorthands. A parameter is either a slider (min/max, optionally on
// a log scale) or a list of options. `key` is the property on the Tone.js node,
// with dots for nested objects ("filter.Q").
const frequencyParam = (key, label, min, max, value) => ({ key, label, min, max, default: value, scale: 'log', unit: 'Hz' });
const rateParam = value => frequencyParam('frequency', 'Rate', 0.05, 20, value);
const depthParam = value => ({ key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, default: value, unit: '%' });
const waveParam = { key: 'type', label: 'Wave', default: 'sine', options: WAVEFORMS };
const feedbackParam = value => ({ key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, default: value, unit: '%' });
const thresholdParam = (key, value, label = 'Threshold') => ({ key, label, min: -60, max: 0, step: 0.5, default: value, unit: 'dB' });
const ratioParam = (key, value, label = 'Ratio') => ({ key, label, min: 1, max: 20, step: 0.1, default: value, unit: ':1' });
const resonanceParam = value => ({ key: 'resonance', label: 'Resonance', min: 0, max: 0.95, step: 0.01, default: value, unit: '%' });
// Comb filters are tuned by their delay time; expose it as the pitch it rings at
const combPitchParam = {
    key: 'pitch', label: 'Pitch', min: 30, max: 2000, default: 220, scale: 'log', unit: 'Hz',
    apply: (node, hz, smooth) => setSignal(node.delayTime, 1 / hz, smooth)
};

const EFFECTS = {
    // Filters & EQ
    filter: {
        label: 'Filter',
        category: 'Filters & EQ',
        create: () => new Tone.Filter(),
        params: [
            {
                key: 'type', label: 'Type', default: 'lowpass', options: [
                    { value: 'lowpass', label: 'Lowpass' },
                    { value: 'highpass', label: 'Highpass' },
                    { value: 'bandpass', label: 'Bandpass' },
                    { value: 'notch', label: 'Notch' },
                    { value: 'allpass', label: 'Allpass' },
                    { value: 'peaking', label: 'Peaking' },
                    { value: 'lowshelf', label: 'Low shelf' },
                    { value: 'highshelf', label: 'High shelf' }
                ]
            },
            frequencyParam('frequency', 'Frequency', 20, 20000, 1000),
            { key: 'Q', label: 'Resonance (Q)', min: 0.1, max: 20, step: 0.1, default: 1 },
            { key: 'gain', label: 'Gain (peak/shelf)', min: -24, max: 12, step: 0.5, default: 6, unit: 'dB' },
            {
                // Tone's rolloff values cascade 1-4 biquads, so the real slopes
                // are 12, 24, 36 and 48 dB/octave
                key: 'rolloff', label: 'Slope', default: -12, options: [
                    { value: -12, label: '12 dB/oct' },
                    { value: -24, label: '24 dB/oct' },
                    { value: -48, label: '36 dB/oct' },
                    { value: -96, label: '48 dB/oct' }
                ]
            }
        ],
        // Each cascaded stage gets the same Q and gain, which would multiply the
        // resonance peak (Q is in dB for lowpass/highpass) and the peak/shelf
        // gain by the number of stages. Split them so the controls mean the same
        // at every slope.
        update: (node, params, smooth) => {
            const stages = [-12, -24, -48, -96].indexOf(params.rolloff) + 1;
            const qInDecibels = params.type === 'lowpass' || params.type === 'highpass';
            node.type = params.type;
            if (node.rolloff !== params.rolloff) {
                node.rolloff = params.rolloff;
            }
            setSignal(node.frequency, params.frequency, smooth);
            setSignal(node.Q, qInDecibels ? params.Q / stages : params.Q, smooth);
            setSignal(node.gain, params.gain / stages, smooth);
        }
    },
    onePoleFilter: {
        label: 'One-Pole Filter',
        category: 'Filters & EQ',
        create: () => new Tone.OnePoleFilter(),
        params: [
            {
                key: 'type', label: 'Type', default: 'lowpass', options: [
                    { value: 'lowpass', label: 'Lowpass' },
                    { value: 'highpass', label: 'Highpass' }
                ]
            },
            {
                ...frequencyParam('frequency', 'Frequency', 20, 5000, 1000),
                // Changing it rebuilds the filter, so don't do that on every slider step
                debounce: 60,
                // Tone's one-pole design goes unstable approaching sampleRate / π
                apply: (node, hz) => {
                    node.frequency = Math.min(hz, node.context.sampleRate / (2 * Math.PI));
                }
            }
        ]
    },
    eq3: {
        label: 'EQ3',
        category: 'Filters & EQ',
        create: () => new Tone.EQ3(),
        params: [
            { key: 'low', label: 'Low', min: -24, max: 12, step: 0.5, default: 0, unit: 'dB' },
            { key: 'mid', label: 'Mid', min: -24, max: 12, step: 0.5, default: 0, unit: 'dB' },
            { key: 'high', label: 'High', min: -24, max: 12, step: 0.5, default: 0, unit: 'dB' },
            frequencyParam('lowFrequency', 'Low/mid split', 50, 1000, 400),
            frequencyParam('highFrequency', 'Mid/high split', 1000, 10000, 2500)
        ]
    },
    combFilter: {
        label: 'Comb Filter',
        category: 'Filters & EQ',
        create: () => new Tone.FeedbackCombFilter(),
        worklet: true,
        level: params => 10 * Math.log10(1 - params.resonance ** 2),
        params: [combPitchParam, resonanceParam(0.7)]
    },
    lowpassCombFilter: {
        label: 'Lowpass Comb Filter',
        category: 'Filters & EQ',
        create: () => new Tone.LowpassCombFilter(),
        worklet: true,
        level: params => 10 * Math.log10(1 - params.resonance ** 2) - 6.5 * Math.log10(params.dampening / 3000) + 2.7,
        params: [combPitchParam, resonanceParam(0.7), frequencyParam('dampening', 'Dampening', 200, 10000, 3000)]
    },
    autoFilter: {
        label: 'Auto Filter',
        category: 'Filters & EQ',
        create: () => new Tone.AutoFilter().start(),
        params: [
            rateParam(0.5),
            depthParam(1),
            frequencyParam('baseFrequency', 'Base frequency', 30, 5000, 200),
            { key: 'octaves', label: 'Range', min: 0, max: 8, step: 0.1, default: 2.6, unit: 'oct' },
            {
                key: 'filter.type', label: 'Filter', default: 'lowpass', options: [
                    { value: 'lowpass', label: 'Lowpass' },
                    { value: 'highpass', label: 'Highpass' },
                    { value: 'bandpass', label: 'Bandpass' },
                    { value: 'notch', label: 'Notch' }
                ]
            },
            { key: 'filter.Q', label: 'Resonance (Q)', min: 0.1, max: 12, step: 0.1, default: 1 },
            waveParam
        ]
    },
    autoWah: {
        label: 'Auto Wah',
        category: 'Filters & EQ',
        create: () => new Tone.AutoWah(),
        params: [
            // Kept so the sweep (base × 2^range) stays below Nyquist
            frequencyParam('baseFrequency', 'Base frequency', 30, 500, 100),
            { key: 'octaves', label: 'Range', min: 1, max: 5, step: 0.1, default: 4, unit: 'oct' },
            { key: 'sensitivity', label: 'Sensitivity', min: -40, max: 0, step: 0.5, default: 0, unit: 'dB' },
            {
                // Its filter is a 3-stage resonant lowpass with Q in dB per stage;
                // expose the total resonance instead
                key: 'resonance', label: 'Resonance', min: 0, max: 12, step: 0.5, default: 6, unit: 'dB',
                apply: (node, decibels, smooth) => setSignal(node.Q, decibels / 3, smooth)
            },
            { key: 'gain', label: 'Peak gain', min: 0, max: 12, step: 0.5, default: 2, unit: 'dB' },
            { key: 'follower', label: 'Response', min: 0.01, max: 1, default: 0.2, scale: 'log', unit: 's' }
        ]
    },

    // Modulation
    chorus: {
        label: 'Chorus',
        category: 'Modulation',
        create: () => new Tone.Chorus().start(),
        mix: 0.5,
        params: [
            rateParam(1.5),
            depthParam(0.7),
            { key: 'delayTime', label: 'Delay', min: 1, max: 20, step: 0.1, default: 3.5, unit: 'ms' },
            feedbackParam(0),
            { key: 'spread', label: 'Stereo spread', min: 0, max: 180, step: 1, default: 180, unit: '°' },
            waveParam
        ]
    },
    phaser: {
        label: 'Phaser',
        category: 'Modulation',
        create: () => new Tone.Phaser(),
        mix: 0.5,
        params: [
            rateParam(0.5),
            { key: 'octaves', label: 'Range', min: 0.5, max: 8, step: 0.1, default: 3, unit: 'oct' },
            frequencyParam('baseFrequency', 'Base frequency', 50, 2000, 350),
            { key: 'Q', label: 'Resonance (Q)', min: 0.5, max: 20, step: 0.1, default: 10 }
        ]
    },
    tremolo: {
        label: 'Tremolo',
        category: 'Modulation',
        create: () => new Tone.Tremolo().start(),
        params: [
            rateParam(4),
            depthParam(0.6),
            { key: 'spread', label: 'Stereo spread', min: 0, max: 180, step: 1, default: 180, unit: '°' },
            waveParam
        ]
    },
    vibrato: {
        label: 'Vibrato',
        category: 'Modulation',
        create: () => new Tone.Vibrato(),
        params: [rateParam(5), depthParam(0.1), waveParam]
    },
    autoPanner: {
        label: 'Auto Panner',
        category: 'Modulation',
        // Two channels so stereo sounds stay stereo instead of being summed first
        create: () => new Tone.AutoPanner({ channelCount: 2 }).start(),
        params: [rateParam(0.5), depthParam(1), waveParam]
    },

    // Pitch
    pitchShift: {
        label: 'Pitch Shift',
        category: 'Pitch',
        create: () => new Tone.PitchShift(),
        params: [
            { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, default: -12, unit: 'st' },
            { key: 'windowSize', label: 'Window', min: 0.02, max: 0.2, step: 0.005, default: 0.1, unit: 's' },
            // Builds up faster than a plain delay
            { ...feedbackParam(0), max: 0.7 }
        ]
    },
    frequencyShifter: {
        label: 'Frequency Shifter',
        category: 'Pitch',
        create: () => new Tone.FrequencyShifter(),
        params: [{ key: 'frequency', label: 'Shift', min: -1000, max: 1000, step: 1, default: 200, unit: 'Hz' }]
    },

    // Delay & Reverb
    feedbackDelay: {
        label: 'Delay',
        category: 'Delay & Reverb',
        create: () => new Tone.FeedbackDelay({ maxDelay: 2 }),
        mix: 0.35,
        params: [
            { key: 'delayTime', label: 'Time', min: 0.01, max: 2, default: 0.25, scale: 'log', unit: 's' },
            feedbackParam(0.4)
        ]
    },
    pingPongDelay: {
        label: 'Ping-Pong Delay',
        category: 'Delay & Reverb',
        create: () => new Tone.PingPongDelay({ maxDelay: 2 }),
        mix: 0.35,
        params: [
            { key: 'delayTime', label: 'Time', min: 0.01, max: 2, default: 0.25, scale: 'log', unit: 's' },
            feedbackParam(0.4)
        ]
    },
    reverb: {
        label: 'Reverb',
        category: 'Delay & Reverb',
        create: () => new Tone.Reverb(),
        mix: 0.4,
        // The convolver normalizes its impulse response per sample, so the wet
        // level rises with the response's length
        level: params => 11.8 - 10 * Math.log10(params.decay + params.preDelay),
        params: [
            // Both regenerate the impulse response, so wait for the slider to settle
            { key: 'decay', label: 'Decay', min: 0.2, max: 20, default: 3, scale: 'log', unit: 's', debounce: 300 },
            { key: 'preDelay', label: 'Pre-delay', min: 0, max: 0.5, step: 0.005, default: 0.01, unit: 's', debounce: 300 }
        ]
    },
    freeverb: {
        label: 'Freeverb',
        category: 'Delay & Reverb',
        create: () => new Tone.Freeverb(),
        worklet: true,
        mix: 0.4,
        level: params => 10 * Math.log10(1 - params.roomSize ** 2) - 6.5 * Math.log10(params.dampening / 3000) - 3.2,
        params: [
            { key: 'roomSize', label: 'Room size', min: 0, max: 0.98, step: 0.01, default: 0.7, unit: '%' },
            frequencyParam('dampening', 'Dampening', 200, 10000, 3000)
        ]
    },
    jcReverb: {
        label: 'JC Reverb',
        category: 'Delay & Reverb',
        create: () => new Tone.JCReverb(),
        worklet: true,
        mix: 0.4,
        level: params => 10 * Math.log10(1 - (0.97 * params.roomSize) ** 2) - 5.9,
        params: [{ key: 'roomSize', label: 'Room size', min: 0, max: 0.95, step: 0.01, default: 0.5, unit: '%' }]
    },

    // Distortion
    distortion: {
        label: 'Distortion',
        category: 'Distortion',
        create: () => new Tone.Distortion(),
        params: [
            { key: 'distortion', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.4, unit: '%' },
            { key: 'oversample', label: 'Oversampling', default: 'none', options: OVERSAMPLING }
        ]
    },
    bitCrusher: {
        label: 'Bit Crusher',
        category: 'Distortion',
        create: () => new Tone.BitCrusher(),
        worklet: true,
        params: [{ key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, default: 4, unit: 'bits' }]
    },
    chebyshev: {
        label: 'Chebyshev',
        category: 'Distortion',
        create: () => new Tone.Chebyshev(),
        params: [
            { key: 'order', label: 'Order', min: 1, max: 100, step: 1, default: 5 },
            { key: 'oversample', label: 'Oversampling', default: 'none', options: OVERSAMPLING }
        ]
    },

    // Dynamics
    compressor: {
        label: 'Compressor',
        category: 'Dynamics',
        create: () => new Tone.Compressor(),
        params: [
            thresholdParam('threshold', -24),
            ratioParam('ratio', 4),
            { key: 'attack', label: 'Attack', min: 0.001, max: 0.5, default: 0.003, scale: 'log', unit: 's' },
            { key: 'release', label: 'Release', min: 0.01, max: 1, default: 0.25, scale: 'log', unit: 's' },
            { key: 'knee', label: 'Knee', min: 0, max: 40, step: 1, default: 30, unit: 'dB' }
        ]
    },
    multibandCompressor: {
        label: 'Multiband Compressor',
        category: 'Dynamics',
        create: () => new Tone.MultibandCompressor(),
        params: [
            frequencyParam('lowFrequency', 'Low/mid split', 50, 1000, 250),
            frequencyParam('highFrequency', 'Mid/high split', 1000, 10000, 2000),
            thresholdParam('low.threshold', -30, 'Low threshold'),
            thresholdParam('mid.threshold', -24, 'Mid threshold'),
            thresholdParam('high.threshold', -24, 'High threshold'),
            {
                ...ratioParam('ratio', 3),
                apply: (node, ratio, smooth) => [node.low, node.mid, node.high].forEach(band => setSignal(band.ratio, ratio, smooth))
            }
        ]
    },
    midSideCompressor: {
        label: 'Mid/Side Compressor',
        category: 'Dynamics',
        create: () => new Tone.MidSideCompressor(),
        params: [
            thresholdParam('mid.threshold', -24, 'Mid threshold'),
            ratioParam('mid.ratio', 3, 'Mid ratio'),
            thresholdParam('side.threshold', -30, 'Side threshold'),
            ratioParam('side.ratio', 6, 'Side ratio')
        ]
    },
    limiter: {
        label: 'Limiter',
        category: 'Dynamics',
        create: () => new Tone.Limiter(),
        params: [{ key: 'threshold', label: 'Threshold', min: -40, max: 0, step: 0.5, default: -12, unit: 'dB' }]
    },
    gate: {
        label: 'Gate',
        category: 'Dynamics',
        create: () => new Tone.Gate(),
        params: [
            { key: 'threshold', label: 'Threshold', min: -100, max: 0, step: 1, default: -40, unit: 'dB' },
            { key: 'smoothing', label: 'Smoothing', min: 0.01, max: 1, default: 0.1, scale: 'log', unit: 's' }
        ]
    },
    gain: {
        label: 'Gain',
        category: 'Dynamics',
        create: () => new Tone.Volume(),
        mix: false,
        params: [{ key: 'volume', label: 'Gain', min: -24, max: 12, step: 0.5, default: 0, unit: 'dB' }]
    },

    // Stereo & Space
    stereoWidener: {
        label: 'Stereo Widener',
        category: 'Stereo & Space',
        create: () => new Tone.StereoWidener(),
        params: [{ key: 'width', label: 'Width', min: 0, max: 1, step: 0.01, default: 0.7, unit: '%' }]
    },
    panner: {
        label: 'Panner',
        category: 'Stereo & Space',
        create: () => new Tone.Panner({ channelCount: 2 }),
        mix: false,
        params: [{ key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, default: 0, unit: 'pan' }]
    },
    panner3d: {
        label: '3D Panner',
        category: 'Stereo & Space',
        create: () => new Tone.Panner3D({ panningModel: 'HRTF' }),
        mix: false,
        params: [
            { key: 'positionX', label: 'Left / right', min: -10, max: 10, step: 0.1, default: 1, unit: 'm' },
            { key: 'positionY', label: 'Down / up', min: -10, max: 10, step: 0.1, default: 0, unit: 'm' },
            { key: 'positionZ', label: 'Front / back', min: -10, max: 10, step: 0.1, default: -1, unit: 'm' },
            {
                key: 'panningModel', label: 'Model', default: 'HRTF', options: [
                    { value: 'HRTF', label: 'HRTF (headphones)' },
                    { value: 'equalpower', label: 'Equal power' }
                ]
            }
        ]
    },
    mono: {
        label: 'Mono',
        category: 'Stereo & Space',
        create: () => new Tone.Mono(),
        params: []
    }
};

// Ready-made chains to start from
const CHAIN_PRESETS = {
    underwater: {
        label: 'Underwater',
        effects: [
            { type: 'filter', params: { frequency: 450, Q: 4, rolloff: -24 } },
            { type: 'chorus', params: { frequency: 0.3, depth: 0.9, delayTime: 8 }, mix: 0.6 },
            { type: 'reverb', params: { decay: 4 }, mix: 0.45 }
        ]
    },
    cathedral: {
        label: 'Cathedral',
        effects: [
            { type: 'eq3', params: { low: 2, high: -6 } },
            { type: 'reverb', params: { decay: 10, preDelay: 0.08 }, mix: 0.7 }
        ]
    },
    oldRadio: {
        label: 'Old Radio',
        effects: [
            { type: 'filter', params: { type: 'bandpass', frequency: 1800, Q: 0.8, rolloff: -24 } },
            { type: 'distortion', params: { distortion: 0.6 }, mix: 0.5 },
            { type: 'bitCrusher', params: { bits: 6 }, mix: 0.4 },
            { type: 'mono' }
        ]
    },
    nextRoom: {
        label: 'Next Room',
        effects: [
            { type: 'filter', params: { frequency: 350, rolloff: -48 } },
            { type: 'jcReverb', params: { roomSize: 0.3 }, mix: 0.3 },
            { type: 'gain', params: { volume: 6 } }
        ]
    },
    wornTape: {
        label: 'Worn Tape',
        effects: [
            { type: 'vibrato', params: { frequency: 0.8, depth: 0.15 } },
            { type: 'chebyshev', params: { order: 3 }, mix: 0.3 },
            { type: 'filter', params: { frequency: 7000 } },
            { type: 'compressor', params: { threshold: -30, ratio: 4 } }
        ]
    },
    drifting: {
        label: 'Drifting',
        effects: [
            { type: 'autoFilter', params: { frequency: 0.08, baseFrequency: 250, octaves: 4 } },
            { type: 'autoPanner', params: { frequency: 0.05, depth: 0.6 } },
            { type: 'stereoWidener', params: { width: 0.8 } },
            { type: 'freeverb', params: { roomSize: 0.9 }, mix: 0.5 }
        ]
    },
    spaceship: {
        label: 'Spaceship',
        effects: [
            { type: 'filter', params: { frequency: 900, rolloff: -24 } },
            { type: 'phaser', params: { frequency: 0.1, octaves: 4, baseFrequency: 150 }, mix: 0.6 },
            { type: 'combFilter', params: { pitch: 55, resonance: 0.5 }, mix: 0.3 },
            { type: 'pingPongDelay', params: { delayTime: 0.6, feedback: 0.5 }, mix: 0.25 }
        ]
    }
};

function setSignal(signal, value, smooth) {
    if (smooth) {
        // Linear, because exponential ramps can't cross zero (frequency shift)
        signal.linearRampTo(value, RAMP_TIME);
    } else {
        signal.value = value;
    }
}

function applyParam(node, param, value, smooth) {
    if (param.apply) {
        param.apply(node, value, smooth);
        return;
    }
    const path = param.key.split('.');
    const property = path.pop();
    const target = path.reduce((object, key) => object[key], node);
    const current = target[property];
    if (current && typeof current.linearRampTo === 'function') {
        setSignal(current, value, smooth);
    } else {
        target[property] = value;
    }
}

function isValidParamValue(param, value) {
    if (param.options) {
        return param.options.some(option => option.value === value);
    }
    if (Number.isInteger(param.step) && !Number.isInteger(value)) {
        return false;
    }
    return Number.isFinite(value) && value >= param.min && value <= param.max;
}

// Turn stored or preset state into a complete, valid unit state, or null if
// the effect type is unknown
function sanitizeEffect(state) {
    const definition = EFFECTS[state?.type];
    if (!definition) {
        return null;
    }
    const params = {};
    for (const param of definition.params) {
        const value = state.params?.[param.key];
        params[param.key] = isValidParamValue(param, value) ? value : param.default;
    }
    // Units without a mix control (mix: false) are always fully wet
    let mix = definition.mix === false ? 1 : definition.mix ?? 1;
    if (definition.mix !== false && Number.isFinite(state.mix)) {
        mix = Math.min(1, Math.max(0, state.mix));
    }
    return { type: state.type, enabled: state.enabled !== false, mix, params };
}

class EffectUnit {
    constructor(state) {
        this.type = state.type;
        this.definition = EFFECTS[state.type];
        this.enabled = state.enabled;
        this.mix = state.mix;
        this.params = { ...state.params };

        this.input = new Tone.Gain();
        // Tone connects nodes through standardized-audio-context, whose connect()
        // checks for feedback loops by walking every signal path downstream of
        // the destination, stopping only at delays (a loop through a delay is
        // allowed). Each unit's dry/wet split doubles those paths, so in a long
        // chain any connection near the front took seconds, including ones Tone
        // makes internally, like when a worklet loads or a filter's slope
        // changes. A zero delay at each unit's output ends that walk; it passes
        // audio through sample for sample.
        this.output = new Tone.Delay({ delayTime: 0, maxDelay: 0.01 });
        // Equal-power dry (a) / wet (b) mix. Starts fully dry; see EffectChain.add
        this.crossFade = new Tone.CrossFade(0);
        this.node = this.definition.create();
        if (this.node.wet) {
            this.node.wet.value = 1; // the cross-fade does the mixing
        }
        this.makeup = new Tone.Gain(Tone.dbToGain(this.levelDecibels()));
        this.input.connect(this.crossFade.a);
        this.input.chain(this.node, this.makeup, this.crossFade.b);
        this.crossFade.connect(this.output);

        if (this.definition.update) {
            this.definition.update(this.node, this.params, false);
        } else {
            for (const param of this.definition.params) {
                applyParam(this.node, param, this.params[param.key], false);
            }
        }
        // Reverb generates its impulse response asynchronously
        this.ready = this.node.ready ?? Promise.resolve();
    }

    levelDecibels() {
        const { level = 0 } = this.definition;
        return typeof level === 'function' ? level(this.params) : level;
    }

    get label() {
        return this.definition.label;
    }

    set(key, value) {
        if (this.node.disposed) {
            return; // e.g. a debounced slider change landing after removal
        }
        this.params[key] = value;
        if (this.definition.update) {
            this.definition.update(this.node, this.params, true);
        } else {
            applyParam(this.node, this.definition.params.find(p => p.key === key), value, true);
        }
        if (typeof this.definition.level === 'function') {
            // Wait for a regenerated reverb impulse response before re-leveling
            Promise.resolve(this.node.ready).then(() => {
                if (!this.node.disposed) {
                    setSignal(this.makeup.gain, Tone.dbToGain(this.levelDecibels()), true);
                }
            });
        }
    }

    setMix(mix) {
        this.mix = mix;
        this.updateFade();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.updateFade();
    }

    // Bypassing fades to fully dry rather than disconnecting, so it never clicks
    updateFade(target = this.enabled ? this.mix : 0) {
        this.crossFade.fade.linearRampTo(target, RAMP_TIME);
    }

    toJSON() {
        return { type: this.type, enabled: this.enabled, mix: this.mix, params: { ...this.params } };
    }

    dispose() {
        [this.input, this.node, this.makeup, this.crossFade, this.output].forEach(node => node.dispose());
    }
}

class EffectChain {
    constructor() {
        this.units = [];   // the order the chain should have
        this.wired = [];   // the order actually connected right now
        this.retired = []; // removed units, disposed once they're unwired
        this.input = new Tone.Gain();
        this.output = new Tone.Gain();
        // Dips briefly while units are removed, reordered or swapped, to avoid clicks
        this.duck = new Tone.Gain(1).connect(this.output);
        this.input.connect(this.duck);
    }

    // Bring the connections in line with this.units, rewiring only from the
    // first position that changed, so appending a unit (the common case)
    // never interrupts the sound passing through the units before it.
    rewire() {
        const link = (units, index) => [
            index === 0 ? this.input : units[index - 1].output,
            index === units.length ? this.duck : units[index].input
        ];
        let unchanged = 0;
        while (unchanged < this.wired.length && this.wired[unchanged] === this.units[unchanged]) {
            unchanged++;
        }
        if (unchanged < this.wired.length || unchanged < this.units.length) {
            for (let i = this.wired.length; i >= unchanged; i--) {
                const [from, to] = link(this.wired, i);
                from.disconnect(to);
            }
            for (let i = unchanged; i <= this.units.length; i++) {
                const [from, to] = link(this.units, i);
                from.connect(to);
            }
            this.wired = [...this.units];
        }
        this.retired.forEach(unit => unit.dispose());
        this.retired = [];
    }

    // Dip the output, rewire, then come back up. Changes made in quick
    // succession share one dip.
    rewireQuietly() {
        this.duck.gain.linearRampTo(0, RAMP_TIME);
        clearTimeout(this.rewireTimer);
        this.rewireTimer = setTimeout(() => {
            this.rewire();
            this.duck.gain.linearRampTo(1, RAMP_TIME);
        }, RAMP_TIME * 1000 + 10);
    }

    // Appending only touches the end of the chain, so it can happen right
    // away. The new unit starts fully dry and fades to its mix.
    add(state) {
        const unit = new EffectUnit(state);
        this.units.push(unit);
        this.rewire();
        unit.updateFade();
        return unit;
    }

    remove(unit) {
        this.units = this.units.filter(u => u !== unit);
        this.retired.push(unit);
        this.rewireQuietly();
    }

    move(unit, offset) {
        const from = this.units.indexOf(unit);
        const to = from + offset;
        if (from < 0 || to < 0 || to >= this.units.length) {
            return;
        }
        this.units.splice(from, 1);
        this.units.splice(to, 0, unit);
        this.rewireQuietly();
    }

    // Swap in a whole new chain (a preset, or none to clear). States that fail
    // to build (e.g. from old saved settings) are skipped.
    replace(states) {
        this.retired.push(...this.units);
        this.units = [];
        for (const state of states) {
            try {
                this.units.push(new EffectUnit(state));
            } catch (error) {
                console.warn(`Skipping ${state.type} effect:`, error);
            }
        }
        this.units.forEach(unit => unit.updateFade());
        this.rewireQuietly();
        return this.units;
    }
}
