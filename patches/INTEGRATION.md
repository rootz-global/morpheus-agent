# Layer 2: Proxy-Router Response Signing Integration

## Overview

Add provider-side response signing to the Morpheus proxy-router HTTP path.
The TCP/MOR RPC path already signs — this adds the same to HTTP.

## Prerequisites

1. Clone `MorpheusAIs/Morpheus-Lumerin-Node`
2. Go 1.22+ installed
3. Provider wallet key available (`WALLET_PRIVATE_KEY` env var)

## Integration Steps

### Step 1: Copy the middleware

```bash
cp response-signing-middleware.go \
  Morpheus-Lumerin-Node/proxy-router/internal/proxyapi/response_signing.go
```

### Step 2: Add wallet to ProxyController

**File:** `proxy-router/internal/proxyapi/controller_http.go`

Find the `ProxyController` struct (~line 30):

```go
// BEFORE:
type ProxyController struct {
    service        *ProxyServiceSender
    aiEngine       *aiengine.AiEngine
    chatStorage    genericchatstorage.ChatStorageInterface
    authConfig     *system.AuthConfig
    // ...
}

// AFTER — add wallet field:
type ProxyController struct {
    service        *ProxyServiceSender
    aiEngine       *aiengine.AiEngine
    chatStorage    genericchatstorage.ChatStorageInterface
    authConfig     *system.AuthConfig
    wallet         interfaces.PrKeyProvider  // ADD THIS
    // ...
}
```

Update `NewProxyController()` to accept and store the wallet:

```go
// BEFORE:
func NewProxyController(service *ProxyServiceSender, aiEngine *aiengine.AiEngine, ...) *ProxyController {
    return &ProxyController{service: service, aiEngine: aiEngine, ...}
}

// AFTER — add wallet parameter:
func NewProxyController(service *ProxyServiceSender, aiEngine *aiengine.AiEngine, ..., wallet interfaces.PrKeyProvider) *ProxyController {
    return &ProxyController{service: service, aiEngine: aiEngine, ..., wallet: wallet}
}
```

### Step 3: Sign responses in the Prompt() callback

**File:** `proxy-router/internal/proxyapi/controller_http.go`

Find the callback in `Prompt()` (~line 230):

```go
// BEFORE:
err = adapter.Prompt(ctx, &body, func(cbctx context.Context, completion gsc.Chunk, aiResponseError *gsc.AiEngineErrorResponse) error {
    marshalledResponse, err := json.Marshal(completion.Data())
    if body.Stream {
        _, err = ctx.Writer.Write([]byte(fmt.Sprintf("data: %s\n\n", marshalledResponse)))
    } else {
        _, err = ctx.Writer.Write(marshalledResponse)
    }
    ctx.Writer.Flush()
    return nil
})

// AFTER — add signing:
err = adapter.Prompt(ctx, &body, func(cbctx context.Context, completion gsc.Chunk, aiResponseError *gsc.AiEngineErrorResponse) error {
    marshalledResponse, err := json.Marshal(completion.Data())

    if body.Stream {
        // Streaming: sign each chunk
        signedData, _ := SignStreamingChunk(marshalledResponse, chunkIdx, body.Model, s.wallet)
        _, err = ctx.Writer.Write([]byte(fmt.Sprintf("data: %s\n\n", signedData)))
        chunkIdx++
    } else {
        // Non-streaming: sign full response, add headers
        SignResponseHeaders(ctx, marshalledResponse, body.Model, s.wallet)
        _, err = ctx.Writer.Write(marshalledResponse)
    }
    ctx.Writer.Flush()
    return nil
})
```

Add `chunkIdx := 0` before the adapter.Prompt call.

### Step 4: Wire wallet from main.go

**File:** `proxy-router/cmd/main.go`

Find where `ProxyController` is created (~line 247):

```go
// BEFORE:
proxyController := proxyapi.NewProxyController(proxySender, aiEngine, ...)

// AFTER — pass wallet:
proxyController := proxyapi.NewProxyController(proxySender, aiEngine, ..., wallet)
```

The `wallet` variable is already created earlier in main.go (~line 220).

### Step 5: Build and test

```bash
cd proxy-router
go build ./cmd/...
```

### Step 6: Verify from agent side

The agent reads the response headers:

```
X-Provider-Signature: 0x... (secp256k1 over keccak256(responseHash|model|timestamp))
X-Provider-Address: 0x... (provider wallet address)
X-Response-Hash: 0x... (SHA-256 of response body)
X-Response-Model: kimi-k2.5
X-Response-Timestamp: 2026-03-28T...
```

The `SecureChannel` in `morpheus-agent` reads these headers and includes the provider signature in the `SecuredInferenceRecord`.

## What This Proves

With this modification:
- **Provider signed the response** — `ecrecover(sig) == providerAddress`
- **Response wasn't modified** — `SHA-256(body) == X-Response-Hash`
- **Specific model was used** — model name in signed payload
- **Timestamp is provider-attested** — included in signature

Combined with Layer 1 (agent signs prompts), this gives **bilateral proof** of the entire conversation.

## Impact on Existing Functionality

- **Zero breaking changes** — headers are additive, unsigned requests still work
- **No protocol changes** — standard HTTP headers, existing API contract unchanged
- **Fail-open** — if wallet is nil or signing fails, response is sent unsigned
- **Performance** — one keccak256 + one secp256k1 sign per response (~1ms)
