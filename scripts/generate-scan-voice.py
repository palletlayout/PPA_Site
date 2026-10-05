"""Regenerate the bundled scan prompts on macOS; playback needs no speech service."""
from pathlib import Path
import array
import subprocess
import sys
import tempfile
import wave

prompts = {"color": "Color","part-number": "Part number", "quantity": "Quantity", "serial": "Serial", "duplicate": "Duplicate"}
destination = Path(__file__).resolve().parents[1] / "public" / "audio" / "scans"
destination.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="ppa-scan-voice-") as temporary:
    for name, phrase in prompts.items():
        source = Path(temporary) / (name + ".aiff")
        converted = Path(temporary) / (name + ".wav")
        subprocess.run(["say", "-v", "Samantha", "-r", "220", "-o", str(source), phrase], check=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1", str(source), str(converted)], check=True)
        with wave.open(str(converted), "rb") as audio:
            samples = array.array("h", audio.readframes(audio.getnframes()))
        if sys.byteorder != "little":
            samples.byteswap()
        audible = [index for index, sample in enumerate(samples) if abs(sample) > 100]
        if not audible:
            raise RuntimeError("The generated prompt is silent: " + name)
        samples = samples[max(0, audible[0] - 240): min(len(samples), audible[-1] + 960)]
        factor = 0.82 * 32767 / max(abs(sample) for sample in samples)
        normalized = array.array("h", (round(sample * factor) for sample in samples))
        if sys.byteorder != "little":
            normalized.byteswap()
        with wave.open(str(destination / (name + ".wav")), "wb") as output:
            output.setparams((1, 2, 24000, len(normalized), "NONE", "not compressed"))
            output.writeframes(normalized.tobytes())
        print(f"{name}: {len(normalized) / 24000:.2f}s")
