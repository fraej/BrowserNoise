// Settings
const STORAGE_KEY = 'browsernoise-settings';
const DEFAULTS = {
    noiseType: 'white',
    volume: -12,
    filterType: 'lowpass',
    frequency: 1000,
    q: 1
};

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_VOLUME = -60;
const NOISE_TYPES = ['white', 'pink', 'brown'];
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
    } catch (e) {
        // Storage unavailable or corrupt: fall back to defaults
    }
    // Discard anything invalid so a bad stored value can't break the audio graph
    const valid = {
        noiseType: v => NOISE_TYPES.includes(v),
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

// Audio graph: noise -> filter -> volume -> speakers
const noise = new Tone.Noise({ type: settings.noiseType, fadeIn: 0.05, fadeOut: 0.05 });
const filter = new Tone.Filter({ type: settings.filterType, frequency: settings.frequency, Q: settings.q });
const volume = new Tone.Volume(settings.volume);
noise.chain(filter, volume, Tone.Destination);

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

// Noise type
const selectNoiseType = setupButtonGroup('noiseType', settings.noiseType, value => {
    noise.type = value;
    settings.noiseType = value;
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
    Object.assign(settings, DEFAULTS);
    saveSettings();

    noise.type = settings.noiseType;
    filter.type = settings.filterType;
    filter.frequency.rampTo(settings.frequency, 0.05);
    filter.Q.rampTo(settings.q, 0.05);
    applyVolume(settings.volume);

    selectNoiseType(settings.noiseType);
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

    const isPlaying = noise.state === 'started';
    if (isPlaying) {
        noise.stop();
    } else {
        noise.start();
    }
    noiseToggle.textContent = isPlaying ? 'Start Noise' : 'Stop Noise';
    noiseToggle.classList.toggle('active', !isPlaying);
    noiseToggle.setAttribute('aria-pressed', !isPlaying);
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
