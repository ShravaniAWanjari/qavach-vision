# Qavach Safety Intelligence: deployment

## 1. Architecture

One container, one port (8830).

```
Browser ── HTTP ──▶ :8830  FastAPI (uvicorn)
                           ├─ serves the React console at /
                           ├─ API at /api
                           ├─ camera threads (OpenCV + ffmpeg, yt-dlp)
                           ├─ person detector (YOLO11s, in process)
                           ├─ fire/smoke detector (YOLOv8n D-Fire, in process)
                           └─ tracker worker (child process per camera with an intrusion rule)
Volume /data: state.json, uploads/, frames/, snapshots/
```

- Console: React 19 SPA. Cameras, rules, walls, alerts and users are stored in browser localStorage. No database.
- Service: detects on connected cameras. The console polls `/api/events` and creates alerts.
- Demo cameras connected by default:
  - DCK-09: `backend/samples/5a3b1e000004.mp4` (copied to `/data/uploads` at start), rule R-12 live.
  - PER-11: public YouTube live stream, rule R-13 test mode. Needs outbound internet.
- Sample video for camera set-up: `backend/samples/5a3b1e000005.mp4` ("Fire and Smoke Detection Sample"). It ships in the image (`COPY backend/samples`) and is copied to `/data/uploads` at start, so the "Sample Video" dropdown (Camera set-up, Upload a video) works on the live link with no upload. It plays in a loop. To add another sample, put a file named with a 12-character hex id in `backend/samples/` and list it in `src/data/samples.ts`.
- Detection runs from first start. A feed that cannot be opened shows "Camera feed interrupted" in the console; the service retries.

## 2. Components

**Console build:** Node 22. react 19.3.1, react-dom 19.3.1, react-router 7.18.5, html-to-image 1.11.11, @fontsource/exo-2 5.3.0. Build: TypeScript 5.9.3, Vite 7.3.7. `npm ci` from `package-lock.json`.

**Service env** (`/opt/service`, Python 3.12), `backend/requirements.txt`:

| Package | Version |
|---|---|
| torch / torchvision | 2.14.1 / 0.29.1 (CPU) |
| ultralytics | 8.3.221 |
| opencv-python | 4.11.0.86 |
| numpy | 2.5.4 |
| fastapi / uvicorn | 0.118.0 / 0.37.0 |
| yt-dlp | unpinned |

**Tracker env** (`/opt/tracker`, Python 3.12), `backend/requirements-tracker.txt`: torch 2.14.1, torchvision 0.29.1, boxmot 25.0.0, numpy 2.5.4, opencv-python 4.14.0.94.

**OS packages:** libgl1, libglib2.0-0, ffmpeg, ca-certificates.

**Model files** (`backend/weights/`, in the image): yolo11s.pt 18 MB, dfire-yolov8n.pt 5.9 MB, reid/osnet_ain_x1_0_msmt17.pt 16 MB.

## 3. Build

```bash
docker build -t qavach ./qavach-safety-intelligence
```

- Stages: `node:22-slim` (console), `python:3.12-slim-bookworm` (runtime).
- Image: about 5 GB. Free disk on build agent: 10 GB.
- Cold build: about 8 minutes. Code-only rebuild reuses cached Python layers.
- pip: `PIP_DEFAULT_TIMEOUT=300`, `PIP_RETRIES=10` set in the Dockerfile.
- Torch build: build arg `TORCH_INDEX`. Default is the CPU wheels (about 200 MB).
  - GPU image: `docker build --build-arg TORCH_INDEX= -t qavach-gpu ./qavach-safety-intelligence` (empty = PyPI Linux wheels with CUDA, image about 2.5 GB larger), or pass a CUDA index such as `https://download.pytorch.org/whl/cu128`.
  - Compose: `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build`.
- Build egress: registry.npmjs.org, pypi.org, download.pytorch.org, Debian mirrors.
- yt-dlp is unpinned; pin it for reproducible builds.
- Tests: `backend/tests/` (pytest, not in the image). Console: `npm run typecheck`.

## 4. Configuration

Container environment variables.

Image defaults: `QAVACH_HOST=0.0.0.0`, `QAVACH_DATA=/data`, `QAVACH_WEB=/app/dist`, `QAVACH_TRACKER_PYTHON=/opt/tracker/bin/python`, `PYTHONUNBUFFERED=1`, `YOLO_CONFIG_DIR=/tmp/ultralytics`.

| Variable | Default | Use |
|---|---|---|
| `QAVACH_DEMO_RTSP_URL` | YouTube live link | Replaces every `rtsp://` address with this stream. Set empty for real RTSP cameras. |
| `QAVACH_DEVICE` | `auto` | `auto`, `cpu`, `mps`, `cuda`, `cuda:N`. An unavailable device falls back to CPU with a message on stderr. |
| `QAVACH_DETECT_SIZE` | 1280 | Person detector input, long side in px. |
| `QAVACH_PREVIEW_WIDTH` | 960 | Preview width. |
| `QAVACH_MAX_HEIGHT` | 1080 | Max YouTube stream height. |
| `QAVACH_DATA` | `/data` | State and media folder. |
| `QAVACH_YOLO_WEIGHTS`, `QAVACH_REID_WEIGHTS`, `QAVACH_FIRE_WEIGHTS` | bundled | Model path overrides. |

- Port: 8830 (image `CMD`).
- Health: `GET /api/health` returns `{"ok":true,"epoch":…,"detector":bool,"device":"cpu"|"cuda:0"|"mps"|null,"cameras":n,"rules":n}`. `device` is null until a rule loads a model.
- Image `HEALTHCHECK`: 15 s interval, 90 s start period.
- Log level: warning.

## 5. Hardware

- Runs on CPU, NVIDIA GPU (CUDA) or Apple GPU (`mps`). `QAVACH_DEVICE=auto` picks CUDA, then `mps`, then CPU. The tracker uses CUDA or CPU. Half precision is on for CUDA.
- The GPU path is untested (no NVIDIA GPU on the development machine). Confirm `device` in `/api/health` after deploy.
- Development machine:
  - Apple M5 (Mac17,2), arm64, macOS 26.5
  - 10 cores (4 performance + 6 efficiency), 24 GB RAM
- Docker Desktop 29.9.2 VM given to containers:
  - 10 CPUs (aarch64), 7.75 GiB RAM, 1 GiB swap
  - Linux kernel 7.0.14 (linuxkit), Python 3.12.16, torch 2.14.1+cpu, 10 torch threads
  - No GPU (containers use `cpu`; native runs on the Mac used `mps`)
- Minimum: 6 GB RAM, 10 GB free disk.
- Measured natively on the Mac (Apple GPU): about 0.13 s per frame (about 7 fps, one camera).
- Measured in the container (CPU, 1280×720 frames, another container was using about 4 of the 10 CPUs at the time, so rerun on a quiet host):

| Model | Input | Mean per frame | Frames/s |
|---|---|---|---|
| YOLO11s person | 1280 px (default) | 1.47 s | 0.7 |
| YOLO11s person | 960 px | 0.96 s | 1.0 |
| D-Fire YOLOv8n fire/smoke | 960 px | 0.48 s | 2.1 |

- Whole service in the container, two demo cameras running (DCK-09 fire/smoke at 24 fps source, PER-11 intrusion at 30 fps source):
  - Idle (no cameras): 53 MiB, about 0% CPU
  - Running: 270 to 370% CPU (about 3.3 of 10 cores), 1.28 to 1.37 GiB RAM, about 58 processes/threads
  - Analysed frames/s: DCK-09 2.1 to 2.6, PER-11 0.5 to 0.6
  - Same load with or without a browser open
- Container start to healthy: under 15 s. Image: 4.98 GB.
- x86 not measured.

- Start with 8 vCPU / 32 GB (for example `Standard_D8s_v5`) and measure.
- On a GPU the detectors stay shared and serialised. Each camera with an intrusion rule also loads its own tracker model onto the GPU, so GPU memory grows with that camera count.
- One person detector and one fire detector, each with its own lock, shared by all cameras.
- Cameras without a rule: preview only, capped at 12 fps.
- Each camera with an intrusion rule starts a tracker process. Fire/smoke rules start none.
- `/data` has no retention. Snapshots, frames and uploads (2 GB max each) stay until deleted. Size the volume accordingly.
- One replica only.

## 6. Azure

- Registry: Azure Container Registry.
- Compute: one replica, fixed size. For GPU use an NC-series VM with the NVIDIA driver and NVIDIA Container Toolkit; run the container with `--gpus all`.
  - VM with `docker compose` (`docker-compose.yml`; remove `127.0.0.1:` from the port mapping), or
  - Container Apps, min = max = 1, target port 8830.
- Storage: mount `/data` (Azure Files or VM managed disk).
- Entry: TLS and sign-in in front (Application Gateway, Front Door, or Container Apps authentication with Entra ID). Do not expose 8830 directly.
- Egress: youtube.com and googlevideo.com (YouTube sources, PER-11); camera networks.
- Cameras: RTSP over TCP (usually port 554) or HTTP/HLS. Route from the VNet to the camera network (VPN or ExpressRoute), no NAT between.
- Sub-path (Nginx location): the console uses no root-absolute URLs. Images, the API (`api/...`) and the video stream are all requested relative to the folder it is served from, so any location works. Nginx must strip the prefix when proxying, and the location needs a trailing slash:

```nginx
location = /qhse-cctv { return 301 /qhse-cctv/; }
location /qhse-cctv/ {
    proxy_pass http://127.0.0.1:8830/;   # trailing slash strips /qhse-cctv/
    proxy_http_version 1.1;
    proxy_buffering off;                 # live MJPEG camera streams
    proxy_read_timeout 3600s;
    client_max_body_size 2g;             # video uploads
}
```

## 7. Constraints

- No authentication on the API. CORS `*`. Roles are enforced in the browser only.
- State is per browser (localStorage). Users do not share cameras, rules or alerts.
- RTSP passwords are saved in plain text in `/data/state.json` (demo setting), so a restart keeps password-protected cameras. Restrict access to the `/data` volume, or move the password to a secret store before production.
- Container runs as root.
- Recent events (300) and tracks are in memory; a restart clears them. Cameras and rules are restored from `state.json` and the console re-sync (`POST /api/sync`).
- Serve the console and `/api` from the same host.

## 8. Run

```bash
docker run -d --name qavach -p 8830:8830 -v qavach-data:/data \
  -e QAVACH_DEMO_RTSP_URL= qavach
curl localhost:8830/api/health
```

- GPU: add `--gpus all` and use the GPU image.
- Backup: the `/data` volume.
- Upgrade: new image, same volume.
