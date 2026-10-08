ARG DISTRO=ubuntu:24.04
FROM ${DISTRO}
ENV DEBIAN_FRONTEND=noninteractive
RUN . /etc/os-release && if [ "$VERSION_ID" = "22.04" ]; then JAVA=openjdk-17-jre-headless; else JAVA=default-jre-headless; fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git xz-utils ffmpeg python3 python3-venv "$JAVA" \
    util-linux build-essential systemd && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY . .
CMD ["python3", "-B", "test/installer_integration.py"]
