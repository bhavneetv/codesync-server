# Code Sync – Runtime Server

This repository contains the **Dockerized runtime execution server** used by Code Sync.  
It is responsible for running user code, handling interactive input, and serving HTML previews.

---

## Main Project Repository

The main Code Sync project (web app + collaboration logic) lives here:

👉 https://github.com/bhavneetv/codesync

---

## What This Server Does

- Executes user code in isolated processes
- Streams stdout / stderr in real time
- Supports interactive stdin
- Serves HTML/CSS/JS previews
- Communicates with the web app via WebSocket

---

## Docker-Based Setup (Recommended)

The server is designed to run **entirely inside Docker**, so no local language runtimes are required on the host machine.

### Prerequisites
- Docker installed and running


