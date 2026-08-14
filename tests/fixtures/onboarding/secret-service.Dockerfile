FROM node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    dbus-daemon \
    gnome-keyring \
    libglib2.0-bin \
    libsecret-tools \
  && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /workspace
