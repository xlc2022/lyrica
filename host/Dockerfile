# host-api and fetch (one image, two commands): Node runs the TypeScript directly (type stripping), so there is no build step
# and no npm dependencies. Build from the repository root: docker build -f host/Dockerfile .
FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
RUN install -d -o 10001 -g 10001 -m 700 /data && install -d -o 10001 -g 10001 -m 755 /models/lyrica && install -d -o 10001 -g 10001 -m 755 /serving
WORKDIR /app
COPY host/src ./src
COPY host/workflows ./workflows
COPY host/recipes/*.json ./recipes/
USER 10001:10001
EXPOSE 7080 7443
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
