# Optional four-stem engine

Sonic integrates the MIT-licensed `python-audio-separator` 0.44.2 command with
Demucs v4 `htdemucs_ft`. It produces four WAV channels beside a finished
Library export: vocals, drums, bass, and other.

The choice is deliberate. Band-Split and MelBand RoFormer are leading modern
architectures, but the readily available high-scoring checkpoints are commonly
two-stem vocal/instrumental models. `htdemucs_ft` is the package's documented
fine-tuned four-stem model and has explicit per-stem quality scores. The engine
is optional because PyTorch and model weights are large and hardware-dependent.

- Project and model table: https://github.com/nomadkaraoke/python-audio-separator
- Demucs project and MIT license: https://github.com/facebookresearch/demucs
- BS-RoFormer paper: https://arxiv.org/abs/2309.02612

Setup creates an isolated Python environment under Sonic's local application
data. Python 3.13 from python.org must be installed. The model is downloaded by
`audio-separator` on the first separation. No audio is uploaded by Sonic.
