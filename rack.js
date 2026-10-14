// Effects panel: add, edit, reorder and remove units in the effect chain

const effectList = document.getElementById('effectChain');
const effectsEmpty = document.getElementById('effectsEmpty');
const effectPicker = document.getElementById('effectPicker');
const addEffectButton = document.getElementById('addEffect');
const chainPresetPicker = document.getElementById('chainPreset');
const loadChainPresetButton = document.getElementById('loadChainPreset');
const clearEffectsButton = document.getElementById('clearEffects');

// Log-scale parameters map slider positions 0..SLIDER_STEPS onto their range
const SLIDER_STEPS = 1000;

const PARAM_FORMATS = {
    Hz: v => (Math.abs(v) < 10 ? `${v.toFixed(2)} Hz` : formatFreq(v)),
    dB: v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
    '%': v => `${Math.round(v * 100)}%`,
    s: v => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`),
    ms: v => `${v.toFixed(1)} ms`,
    st: v => `${v > 0 ? '+' : ''}${v} st`,
    '°': v => `${Math.round(v)}°`,
    ':1': v => `${v.toFixed(1)}:1`,
    oct: v => `${v.toFixed(1)} oct`,
    bits: v => `${v} bits`,
    m: v => `${v.toFixed(1)} m`,
    pan: v => (Math.abs(v) < 0.005 ? 'Center' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'L' : 'R'}`)
};

function formatParam(param, value) {
    const format = PARAM_FORMATS[param.unit];
    if (format) {
        return format(value);
    }
    return value.toFixed(param.step >= 1 ? 0 : param.step >= 0.1 ? 1 : 2);
}

function sliderAttributes(param) {
    if (param.scale === 'log') {
        return { min: 0, max: SLIDER_STEPS, step: 1 };
    }
    return { min: param.min, max: param.max, step: param.step ?? (param.max - param.min) / 100 };
}

function toSlider(param, value) {
    if (param.scale !== 'log') {
        return value;
    }
    return (Math.log(value / param.min) / Math.log(param.max / param.min)) * SLIDER_STEPS;
}

function fromSlider(param, position) {
    if (param.scale !== 'log') {
        return position;
    }
    const value = Number((param.min * (param.max / param.min) ** (position / SLIDER_STEPS)).toPrecision(4));
    return Math.min(param.max, Math.max(param.min, value));
}

function el(tag, properties = {}, children = []) {
    const element = Object.assign(document.createElement(tag), properties);
    element.append(...children);
    return element;
}

function iconButton(text, label, action) {
    const button = el('button', { type: 'button', className: 'icon-button', textContent: text, title: label });
    button.dataset.action = action;
    button.setAttribute('aria-label', label);
    return button;
}

function createParamControl(id, param, value, onChange) {
    const label = el('label', { htmlFor: id, textContent: param.label });

    if (param.options) {
        const select = el('select', { id }, param.options.map(option => (
            el('option', { value: String(option.value), textContent: option.label })
        )));
        select.value = String(value);
        select.addEventListener('change', () => onChange(param.options[select.selectedIndex].value));
        return el('div', { className: 'param' }, [label, select]);
    }

    const output = el('output', { textContent: formatParam(param, value) });
    output.setAttribute('for', id);
    const slider = el('input', { type: 'range', className: 'slider', id, ...sliderAttributes(param) });
    slider.value = toSlider(param, value);
    slider.setAttribute('aria-valuetext', output.textContent);

    let timer;
    slider.addEventListener('input', () => {
        const next = fromSlider(param, parseFloat(slider.value));
        output.textContent = formatParam(param, next);
        slider.setAttribute('aria-valuetext', output.textContent);
        // Expensive parameters (like reverb decay) wait for the slider to settle
        clearTimeout(timer);
        if (param.debounce) {
            timer = setTimeout(() => onChange(next), param.debounce);
        } else {
            onChange(next);
        }
    });
    return el('div', { className: 'param' }, [el('div', { className: 'param-label' }, [label, output]), slider]);
}

let cardCount = 0;

function createEffectCard(unit) {
    const { label, category, params, mix } = unit.definition;
    const id = `fx${++cardCount}`;
    const card = el('li', { className: 'effect' });

    const power = el('button', { type: 'button', className: 'effect-power', title: 'Turn on or off (bypass)' }, [
        el('span', { className: 'led' }), 'On'
    ]);
    power.setAttribute('aria-label', `${label} on`);
    const up = iconButton('↑', `Move ${label} up`, 'up');
    const down = iconButton('↓', `Move ${label} down`, 'down');
    const remove = iconButton('✕', `Remove ${label}`, 'remove');
    card.append(el('div', { className: 'effect-header' }, [
        el('span', { className: 'effect-index' }),
        el('h3', { className: 'effect-name' }, [label, ' ', el('span', { className: 'effect-category', textContent: category })]),
        power, up, down, remove
    ]));

    const controls = [];
    if (mix !== false) {
        const mixParam = { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, unit: '%' };
        controls.push(createParamControl(`${id}-mix`, mixParam, unit.mix, value => {
            unit.setMix(value);
            saveEffects();
        }));
    }
    for (const param of params) {
        controls.push(createParamControl(`${id}-${param.key.replace('.', '-')}`, param, unit.params[param.key], value => {
            unit.set(param.key, value);
            saveEffects();
        }));
    }
    if (controls.length > 0) {
        card.append(el('div', { className: 'effect-params' }, controls));
    }

    const showEnabled = () => {
        power.setAttribute('aria-pressed', unit.enabled);
        card.classList.toggle('bypassed', !unit.enabled);
    };
    showEnabled();
    power.addEventListener('click', () => {
        unit.setEnabled(!unit.enabled);
        showEnabled();
        saveEffects();
    });
    up.addEventListener('click', () => moveEffect(card, unit, -1, up, down));
    down.addEventListener('click', () => moveEffect(card, unit, 1, down, up));
    remove.addEventListener('click', () => removeEffect(card, unit));
    return card;
}

function saveEffects() {
    settings.effects = effectChain.units.map(unit => unit.toJSON());
    saveSettings();
}

// Number the cards and enable only the moves that are possible
function updateEffectList() {
    const cards = [...effectList.children];
    cards.forEach((card, index) => {
        card.querySelector('.effect-index').textContent = index + 1;
        card.querySelector('[data-action=up]').disabled = index === 0;
        card.querySelector('[data-action=down]').disabled = index === cards.length - 1;
    });
    effectsEmpty.hidden = cards.length > 0;
    clearEffectsButton.disabled = cards.length === 0;
    addEffectButton.disabled = cards.length >= MAX_EFFECTS;
}

function moveEffect(card, unit, offset, pressed, opposite) {
    effectChain.move(unit, offset);
    // Move the neighbour rather than the card, so focus stays on the button
    if (offset < 0) {
        card.after(card.previousElementSibling);
    } else {
        card.before(card.nextElementSibling);
    }
    updateEffectList();
    if (pressed.disabled) {
        opposite.focus();
    }
    saveEffects();
}

function removeEffect(card, unit) {
    const neighbour = card.nextElementSibling ?? card.previousElementSibling;
    effectChain.remove(unit);
    card.remove();
    updateEffectList();
    saveEffects();
    (neighbour?.querySelector('[data-action=remove]') ?? effectPicker).focus();
}

function showEffects(units) {
    effectList.replaceChildren(...units.map(createEffectCard));
    updateEffectList();
}

addEffectButton.addEventListener('click', () => {
    const card = createEffectCard(effectChain.add(sanitizeEffect({ type: effectPicker.value })));
    effectList.append(card);
    updateEffectList();
    saveEffects();
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
});

loadChainPresetButton.addEventListener('click', () => {
    const preset = CHAIN_PRESETS[chainPresetPicker.value];
    if (effectChain.units.length > 0 && !confirm(`Replace your effects with the ${preset.label} chain?`)) {
        return;
    }
    showEffects(effectChain.replace(preset.effects.map(sanitizeEffect)));
    saveEffects();
});

clearEffectsButton.addEventListener('click', () => {
    if (!confirm('Remove all effects?')) {
        return;
    }
    showEffects(effectChain.replace([]));
    saveEffects();
    effectPicker.focus();
});

// Fill the pickers, grouping effects by category. Effects that need
// AudioWorklets are listed but disabled when the page is opened from disk.
const effectGroups = new Map();
for (const [type, definition] of Object.entries(EFFECTS)) {
    if (!effectGroups.has(definition.category)) {
        effectGroups.set(definition.category, el('optgroup', { label: definition.category }));
    }
    const available = isEffectAvailable(type);
    effectGroups.get(definition.category).append(el('option', {
        value: type,
        textContent: available ? definition.label : `${definition.label} (needs a web server)`,
        disabled: !available
    }));
}
effectPicker.append(...effectGroups.values());

for (const [id, preset] of Object.entries(CHAIN_PRESETS)) {
    const available = preset.effects.every(state => isEffectAvailable(state.type));
    chainPresetPicker.append(el('option', {
        value: id,
        textContent: available ? preset.label : `${preset.label} (needs a web server)`,
        disabled: !available
    }));
}
document.getElementById('effectsFileNote').hidden = WORKLETS_AVAILABLE;

// Restore the saved chain
showEffects(effectChain.replace(settings.effects));
saveEffects();
