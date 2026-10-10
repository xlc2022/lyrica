# host-api: Node runs the TypeScript directly (type stripping), so there is no build step
# and no npm dependencies. Build from the repository root: docker build -f host/Dockerfile .
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
RUN install -d -o 10001 -g 10001 -m 700 /data && install -d -o 10001 -g 10001 -m 755 /serving
WORKDIR /app
COPY host/src ./src
USER 10001:10001
EXPOSE 7080 7443
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
