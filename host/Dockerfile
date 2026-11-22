# host-api and fetch (one image, two commands): Node runs the TypeScript directly (type stripping), so there is no build step
# and no npm dependencies. Build from the repository root: docker build -f host/Dockerfile .
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN install -d -o 10001 -g 10001 -m 700 /data && install -d -o 10001 -g 10001 -m 755 /models/lyrica && install -d -o 10001 -g 10001 -m 755 /serving
WORKDIR /app
COPY host/src ./src
COPY host/workflows ./workflows
COPY host/recipes/*.json ./recipes/
USER 10001:10001
EXPOSE 7080 7443
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
