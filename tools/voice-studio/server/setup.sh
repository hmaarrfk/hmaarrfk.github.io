#!/usr/bin/env bash
#
# One-time setup for making and serving your voice (Apple-silicon Mac).
#
#   ./setup.sh            # conda env "voxcpm" + VoxCPM + dependencies
#
# Then:
#   conda activate voxcpm
#   python make_voice.py ~/path/to/recordings --name me     # → me.voice.zip
#   python voice_server.py                                  # serves it to the Video Compressor
#
# Needs: conda (miniforge) and git. Downloads ~5 GB of models on first use
# (VoxCPM2, Whisper, the speaker encoder), into ~/.cache/huggingface.
set -euo pipefail

ENV="${VOICE_ENV:-voxcpm}"
HOME_DIR="${VOICE_HOME:-$HOME/voice-clone}"
VOXCPM_REV="f772e498a45fbb5fb8e13fbf9b9c48be9fe33e69"   # the trainer this was built and measured with
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "note: built and tested on Apple-silicon macOS; elsewhere, expect to adjust PyTorch/MLX." >&2
fi
CONDA="$(command -v mamba || command -v conda || true)"
[[ -n "$CONDA" ]] || { echo "conda/mamba not found — install miniforge first" >&2; exit 1; }

if ! "$CONDA" env list | awk '{print $1}' | grep -qx "$ENV"; then
  "$CONDA" create -y -n "$ENV" -c conda-forge python=3.11 pip ffmpeg
fi
PY="$("$CONDA" run -n "$ENV" python -c 'import sys; print(sys.executable)')"

mkdir -p "$HOME_DIR"
if [[ ! -d "$HOME_DIR/VoxCPM/.git" ]]; then
  git clone https://github.com/OpenBMB/VoxCPM "$HOME_DIR/VoxCPM"
fi
git -C "$HOME_DIR/VoxCPM" fetch -q origin "$VOXCPM_REV" 2>/dev/null || true
git -C "$HOME_DIR/VoxCPM" checkout -q "$VOXCPM_REV"

"$PY" -m pip install -q -e "$HOME_DIR/VoxCPM" -r "$HERE/requirements.txt"
"$PY" -c "import voxcpm, mlx_whisper, speechbrain, torch; assert torch.backends.mps.is_available(), 'no Apple GPU (MPS)'; print('ready:', torch.__version__)"
echo
echo "Done. Next:  conda activate $ENV && python $HERE/make_voice.py <folder of recordings> --name <you>"
