# host-api and fetch (one image, two commands): Node runs the TypeScript directly (type stripping), so there is no build step
# and no npm dependencies. Build from the repository root: docker build -f host/Dockerfile .
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
RUN install -d -o 10001 -g 10001 -m 700 /data && install -d -o 10001 -g 10001 -m 755 /models/lyrica && install -d -o 10001 -g 10001 -m 755 /serving
WORKDIR /app
COPY host/src ./src
COPY host/workflows ./workflows
COPY host/recipes/*.json ./recipes/
USER 10001:10001
EXPOSE 7080 7443
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
