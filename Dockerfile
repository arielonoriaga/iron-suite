FROM rust:1-slim-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN cargo build --release --locked --bin iron

FROM debian:bookworm-slim
WORKDIR /app

RUN useradd -m -u 10001 iron \
    && mkdir -p /data \
    && chown iron:iron /data \
    && chmod 700 /data

COPY --from=builder /app/target/release/iron /usr/local/bin/iron

USER iron
ENV HOME=/home/iron

# Initialize a ready-to-query SQLite FTS5 store so cold-start MCP introspection and tool calls succeed immediately.
RUN /usr/local/bin/iron memory remember \
    --db /data/memory.db \
    --project iron-suite \
    --kind note \
    --title "Iron Suite MCP Memory Hub Initialized" \
    --content "Zero-cloud SQLite FTS5 + stdio MCP memory store ready for search, recall, graph links, and reinforcement."

ENTRYPOINT ["/usr/local/bin/iron", "--db", "/data/memory.db", "mcp"]
