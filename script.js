// Settings
const STORAGE_KEY = 'browsernoise-settings';
const DEFAULTS = {
    sound: 'white',
    volume: -6,
    // The filter starts fully open so presets are heard as designed
    filterType: 'lowpass',
    frequency: 20000,
    q: 0.7,
    effects: []
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
    settings.effects = Array.isArray(settings.effects) ? settings.effects
        .map(sanitizeEffect)
        .filter(state => state && isEffectAvailable(state.type))
        .slice(0, MAX_EFFECTS) : [];
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

// Audio graph: sound preset -> filter -> effects -> volume -> limiter -> speakers
// (the limiter catches peaks from thunder, resonant filters or effects)
const filter = new Tone.Filter({ type: settings.filterType, frequency: settings.frequency, Q: settings.q });
const effectChain = new EffectChain();
const volume = new Tone.Volume(settings.volume);
filter.connect(effectChain.input);
effectChain.output.chain(volume, new Tone.Limiter(-1), Tone.Destination);

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
        // Screen readers announce this rather than the raw slider position
        slider.setAttribute('aria-valuetext', output.textContent);
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
    updateMenuStatus();
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

// Reset sound, volume and filter to defaults (effects have their own Clear)
document.getElementById('resetSettings').addEventListener('click', () => {
    if (settings.sound !== DEFAULTS.sound) {
        switchSound(DEFAULTS.sound);
    }
    Object.assign(settings, DEFAULTS, { effects: settings.effects });
    saveSettings();

    filter.type = settings.filterType;
    filter.frequency.rampTo(settings.frequency, 0.05);
    filter.Q.rampTo(settings.q, 0.05);
    applyVolume(settings.volume);

    selectSound(settings.sound);
    updateMenuStatus();
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
    updateMenuStatus();
}

noiseToggle.addEventListener('click', toggleNoise);

// Space toggles playback, unless a button or menu has focus (they use Space)
document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat || e.target.closest('button, select')) {
        return;
    }
    e.preventDefault();
    toggleNoise();
});

// Menu bar: what's playing, and a clock
const menuStatus = document.getElementById('menuStatus');
const menuClock = document.getElementById('menuClock');

function updateMenuStatus() {
    const soundButton = document.querySelector(`#sound [data-value="${settings.sound}"]`);
    menuStatus.textContent = isPlaying ? `♪ ${soundButton.textContent}` : '';
}

function updateClock() {
    menuClock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
updateClock();
setInterval(updateClock, 10000);

// A window's collapse box rolls it up to its title bar, like Mac OS 8's
// windowshade; double-clicking the title bar does the same
for (const windowElement of document.querySelectorAll('.window')) {
    const collapseBox = windowElement.querySelector('.collapse-box');
    const toggleCollapsed = () => {
        const collapsed = windowElement.classList.toggle('collapsed');
        collapseBox.setAttribute('aria-expanded', !collapsed);
    };
    collapseBox.addEventListener('click', toggleCollapsed);
    windowElement.querySelector('.title-bar').addEventListener('dblclick', event => {
        if (event.target !== collapseBox) {
            toggleCollapsed();
        }
    });
}
