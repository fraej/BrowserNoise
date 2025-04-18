// Initialize audio components
const noise = new Tone.Noise("white").start();
const filter = new Tone.Filter({
    type: "lowpass",
    frequency: 1000,
    Q: 1
});
const volume = new Tone.Volume(-20);

// Connect components
noise.chain(filter, volume, Tone.Destination);
noise.stop(); // Initially stopped

// UI Controls
const noiseToggle = document.getElementById('noiseToggle');
let isPlaying = false;

// Noise Type Control
document.querySelectorAll('#noiseType .option-button').forEach(button => {
    button.addEventListener('click', e => {
        const currentState = noise.state;
        noise.stop();
        noise.type = e.target.dataset.value;
        // Update active button
        document.querySelectorAll('#noiseType .option-button').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        if (currentState === 'started') {
            noise.start();
        }
    });
});

// Volume Control
document.getElementById('noiseVolume').addEventListener('input', e => {
    const value = parseFloat(e.target.value);
    volume.volume.value = value;
    document.getElementById('volumeValue').textContent = `${value.toFixed(1)} dB`;
});

// Filter Type Control
document.querySelectorAll('#filterType .option-button').forEach(button => {
    button.addEventListener('click', e => {
        filter.type = e.target.dataset.value;
        // Update active button
        document.querySelectorAll('#filterType .option-button').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
    });
});

// Filter Frequency Control
document.getElementById('filterFreq').addEventListener('input', e => {
    const value = parseFloat(e.target.value);
    filter.frequency.value = value;
    document.getElementById('freqValue').textContent = `${value.toFixed(0)} Hz`;
});

// Filter Q Control
document.getElementById('filterQ').addEventListener('input', e => {
    const value = parseFloat(e.target.value);
    filter.Q.value = value;
    document.getElementById('qValue').textContent = value.toFixed(1);
});

// Noise Toggle
noiseToggle.addEventListener('click', async () => {
    // Start audio context if needed
    await Tone.start();

    if (isPlaying) {
        noise.stop();
        noiseToggle.textContent = 'Start Noise';
        noiseToggle.classList.remove('active');
    } else {
        noise.start();
        noiseToggle.textContent = 'Stop Noise';
        noiseToggle.classList.add('active');
    }
    isPlaying = !isPlaying;
});

// Log scale conversion for frequency slider
document.getElementById('filterFreq').addEventListener('input', function (e) {
    const min = Math.log(20);
    const max = Math.log(20000);
    const scale = (max - min) / (100 - 0);
    const value = Math.exp(min + scale * (e.target.value - 0));
    filter.frequency.value = value;
    document.getElementById('freqValue').textContent = `${Math.round(value)} Hz`;
});

// Initialize frequency slider with logarithmic scale
const freqSlider = document.getElementById('filterFreq');
freqSlider.setAttribute('step', '1');
freqSlider.setAttribute('min', '0');
freqSlider.setAttribute('max', '100');
const initialFreq = Math.log(1000);
const minFreq = Math.log(20);
const maxFreq = Math.log(20000);
const scale = (maxFreq - minFreq) / (100 - 0);
freqSlider.value = (initialFreq - minFreq) / scale;
