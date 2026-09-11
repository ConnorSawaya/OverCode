# Overcode Mobile Relay

This service is a stateless WebSocket relay for Overcode Mobile. It forwards authenticated HTTP, Server-Sent Events, terminal WebSockets, cancellation, and disconnects between one desktop connector and its paired mobile clients. It never stores workspace data or request bodies.

Pairing uses a six-digit code that the desktop connector registers for five minutes. `POST /pair` exchanges that one-time code for a device token; the token remains valid until the desktop revokes the channel or removes that device. `GET /devices` and `DELETE /devices/:id` are connector-only management endpoints.

## Local run

```powershell
$env:PORT = "3000"
bun run start
```

Health is available at `/health`; aggregate Prometheus-style connection and latency metrics are available at `/metrics`.

## Deployment

The package includes a Dockerfile for Railway. The service listens on Railway's injected `PORT` and binds all interfaces. The desktop connector authenticates with the random channel token carried internally by the pairing URI registration; phones receive a separate device token after the one-time code exchange.
