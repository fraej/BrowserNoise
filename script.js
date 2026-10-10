// Settings
const STORAGE_KEY = 'browsernoise-settings';
const DEFAULTS = {
    sound: 'white',
    volume: -6,
    // The filter starts fully open so presets are heard as designed
    filterType: 'lowpass',
    frequency: 20000,
    q: 0.7
};

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_VOLUME = -60;
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];

function loadSettings() {
    const settings = { ...DEFAULTS };
    try {
        Object.assign(settings, JSON.parse(localStorage.getItem(STORAGE_KEY)));
        // Migrate the volume stored by earlier versions
        const legacyVolume = localStorage.getItem('volume');
        if (legacyVolume !== null) {
            settings.volume = parseFloat(legacyVolume);
            localStorage.removeItem('volume');
        }
        // Earlier versions only had noise types
        if (settings.noiseType) {
            settings.sound = settings.noiseType;
            delete settings.noiseType;
        }
    } catch (e) {
        // Storage unavailable or corrupt: fall back to defaults
    }
    // Discard anything invalid so a bad stored value can't break the audio graph
    const valid = {
        sound: v => Object.hasOwn(SOUNDS, v),
        filterType: v => FILTER_TYPES.includes(v),
        volume: v => Number.isFinite(v) && v >= MIN_VOLUME && v <= 0,
        frequency: v => Number.isFinite(v) && v >= MIN_FREQ && v <= MAX_FREQ,
        q: v => Number.isFinite(v) && v > 0 && v <= 20
    };
    for (const key of Object.keys(valid)) {
        if (!valid[key](settings[key])) {
            settings[key] = DEFAULTS[key];
        }
    }
    return settings;
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        // Storage unavailable (e.g. private mode): settings just won't persist
    }
}

const settings = loadSettings();

// Audio graph: sound preset -> filter -> volume -> limiter -> speakers
// (the limiter catches peaks from thunder or a resonant filter setting)
const filter = new Tone.Filter({ type: settings.filterType, frequency: settings.frequency, Q: settings.q });
const volume = new Tone.Volume(settings.volume);
filter.chain(volume, new Tone.Limiter(-1), Tone.Destination);

let sound = createSound(settings.sound, filter);
let isPlaying = false;

// Crossfade to another preset, disposing the old one once it has faded out
function switchSound(id) {
    const previous = sound;
    sound = createSound(id, filter);
    if (isPlaying) {
        previous.stop();
        sound.start();
        setTimeout(() => previous.dispose(), FADE_TIME * 1000 + 500);
    } else {
        previous.dispose();
    }
}

// Frequency slider uses a logarithmic scale so each octave gets equal travel
const freqSlider = document.getElementById('filterFreq');
const freqSliderMax = parseFloat(freqSlider.max);
const logMin = Math.log(MIN_FREQ);
const logMax = Math.log(MAX_FREQ);

function sliderToFreq(position) {
    return Math.exp(logMin + (logMax - logMin) * (position / freqSliderMax));
}

function freqToSlider(freq) {
    return ((Math.log(freq) - logMin) / (logMax - logMin)) * freqSliderMax;
}

function formatFreq(freq) {
    return freq >= 1000 ? `${(freq / 1000).toFixed(freq >= 10000 ? 1 : 2)} kHz` : `${Math.round(freq)} Hz`;
}

// UI helpers
function setupButtonGroup(groupId, initialValue, onSelect) {
    const buttons = document.querySelectorAll(`#${groupId} .option-button`);
    const select = value => {
        buttons.forEach(btn => {
            const isActive = btn.dataset.value === value;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive);
        });
    };
    buttons.forEach(button => {
        button.addEventListener('click', () => {
            select(button.dataset.value);
            onSelect(button.dataset.value);
        });
    });
    select(initialValue);
    return select;
}

function setupSlider(sliderId, outputId, initialValue, format, onInput) {
    const slider = document.getElementById(sliderId);
    const output = document.getElementById(outputId);
    const update = () => {
        const value = parseFloat(slider.value);
        output.textContent = format(value);
        return value;
    };
    slider.addEventListener('input', () => onInput(update()));
    const set = value => {
        slider.value = value;
        update();
    };
    set(initialValue);
    return set;
}

// Sound preset
const selectSound = setupButtonGroup('sound', settings.sound, value => {
    if (value === settings.sound) {
        return;
    }
    switchSound(value);
    settings.sound = value;
    saveSettings();
});

// Volume (the bottom of the range mutes completely)
const formatVolume = value => (value <= MIN_VOLUME ? 'Muted' : `${value.toFixed(0)} dB`);
function applyVolume(value) {
    if (value <= MIN_VOLUME) {
        volume.mute = true;
    } else {
        volume.mute = false;
        volume.volume.rampTo(value, 0.05);
    }
}
applyVolume(settings.volume);
const setVolume = setupSlider('noiseVolume', 'volumeValue', settings.volume, formatVolume, value => {
    applyVolume(value);
    settings.volume = value;
    saveSettings();
});

// Filter type
const selectFilterType = setupButtonGroup('filterType', settings.filterType, value => {
    filter.type = value;
    settings.filterType = value;
    saveSettings();
});

// Filter frequency
const setFreqSlider = setupSlider('filterFreq', 'freqValue', freqToSlider(settings.frequency),
    position => formatFreq(sliderToFreq(position)),
    position => {
        const freq = sliderToFreq(position);
        filter.frequency.rampTo(freq, 0.05);
        settings.frequency = freq;
        saveSettings();
    });

// Filter Q
const setQ = setupSlider('filterQ', 'qValue', settings.q, value => value.toFixed(1), value => {
    filter.Q.rampTo(value, 0.05);
    settings.q = value;
    saveSettings();
});

// Reset everything to defaults
document.getElementById('resetSettings').addEventListener('click', () => {
    if (settings.sound !== DEFAULTS.sound) {
        switchSound(DEFAULTS.sound);
    }
    Object.assign(settings, DEFAULTS);
    saveSettings();

    filter.type = settings.filterType;
    filter.frequency.rampTo(settings.frequency, 0.05);
    filter.Q.rampTo(settings.q, 0.05);
    applyVolume(settings.volume);

    selectSound(settings.sound);
    selectFilterType(settings.filterType);
    setVolume(settings.volume);
    setFreqSlider(freqToSlider(settings.frequency));
    setQ(settings.q);
});

// Start / stop
const noiseToggle = document.getElementById('noiseToggle');

async function toggleNoise() {
    // Browsers only allow audio to start after a user gesture
    await Tone.start();

    // Presets schedule their random events (drops, waves, gusts) on the Transport
    const transport = Tone.getTransport();
    if (transport.state !== 'started') {
        transport.start();
    }

    isPlaying = !isPlaying;
    if (isPlaying) {
        sound.start();
    } else {
        sound.stop();
    }
    noiseToggle.textContent = isPlaying ? 'Stop' : 'Play';
    noiseToggle.classList.toggle('active', isPlaying);
    noiseToggle.setAttribute('aria-pressed', isPlaying);
}

noiseToggle.addEventListener('click', toggleNoise);

// Space toggles playback, unless a button has focus (it handles Space itself)
document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat || e.target.closest('button')) {
        return;
    }
    e.preventDefault();
    toggleNoise();
});
