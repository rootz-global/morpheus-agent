// response-signing-middleware.go
//
// DROP-IN middleware for Morpheus proxy-router that signs every HTTP inference response
// with the provider's secp256k1 wallet key.
//
// WHERE TO ADD THIS:
//   File: proxy-router/internal/proxyapi/response_signing.go (new file)
//
// HOW TO WIRE IT:
//   1. Add PrKeyProvider to ProxyController struct in controller_http.go
//   2. Pass wallet from main.go when creating ProxyController
//   3. Call signResponse() in the Prompt() callback before writing to ctx.Writer
//   4. For non-streaming: sign full response body, add headers
//   5. For streaming: accumulate hash across chunks, sign final hash in trailer
//
// The signing function already exists in the codebase:
//   internal/lib/crypto.go: crypto.Sign(keccak256(data), privateKey)
// This middleware reuses that exact pattern.

package proxyapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/MorpheusAIs/Morpheus-Lumerin-Node/proxy-router/internal/interfaces"
	"github.com/MorpheusAIs/Morpheus-Lumerin-Node/proxy-router/internal/lib"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/gin-gonic/gin"
)

// ResponseSignature is the signed envelope added to inference responses.
// The agent reads these headers to verify the provider signed the response.
type ResponseSignature struct {
	// SHA-256 hash of the response body
	ResponseHash string `json:"responseHash"`
	// Provider's Ethereum address
	ProviderAddress string `json:"providerAddress"`
	// secp256k1 signature over (responseHash | model | timestamp)
	Signature string `json:"signature"`
	// Model that generated the response
	Model string `json:"model"`
	// ISO 8601 timestamp
	Timestamp string `json:"timestamp"`
}

// SignResponseHeaders signs the response body and adds signature headers.
//
// Call this in the Prompt() callback in controller_http.go, right before
// writing the response to ctx.Writer.
//
// Usage in controller_http.go Prompt() callback:
//
//	marshalledResponse, _ := json.Marshal(completion.Data())
//	sig := SignResponseHeaders(ctx, marshalledResponse, model, s.wallet)
//	// Headers are already set on ctx.Writer by this function
//	ctx.Writer.Write(marshalledResponse)
//
func SignResponseHeaders(
	ctx *gin.Context,
	responseBody []byte,
	model string,
	wallet interfaces.PrKeyProvider,
) *ResponseSignature {
	if wallet == nil {
		return nil
	}

	// Get private key from wallet
	privKeyHex, err := wallet.GetPrivateKey()
	if err != nil {
		return nil
	}

	// SHA-256 hash of the response body
	hash := sha256.Sum256(responseBody)
	responseHash := "0x" + hex.EncodeToString(hash[:])

	// Derive provider address from private key
	privKey, err := crypto.ToECDSA([]byte(privKeyHex))
	if err != nil {
		return nil
	}
	providerAddr := crypto.PubkeyToAddress(privKey.PublicKey)

	// Timestamp
	timestamp := time.Now().UTC().Format(time.RFC3339)

	// Build signing payload: responseHash | model | timestamp
	signingPayload := fmt.Sprintf("%s|%s|%s", responseHash, model, timestamp)
	payloadHash := crypto.Keccak256Hash([]byte(signingPayload))

	// Sign with secp256k1 (same pattern as MOR RPC signing in mor_rpc.go)
	sigBytes, err := crypto.Sign(payloadHash.Bytes(), privKey)
	if err != nil {
		return nil
	}
	signature := "0x" + hex.EncodeToString(sigBytes)

	// Build response signature struct
	sig := &ResponseSignature{
		ResponseHash:    responseHash,
		ProviderAddress: providerAddr.Hex(),
		Signature:       signature,
		Model:           model,
		Timestamp:       timestamp,
	}

	// Set HTTP headers (agent reads these)
	ctx.Header("X-Provider-Signature", signature)
	ctx.Header("X-Provider-Address", providerAddr.Hex())
	ctx.Header("X-Response-Hash", responseHash)
	ctx.Header("X-Response-Model", model)
	ctx.Header("X-Response-Timestamp", timestamp)

	return sig
}

// SignStreamingChunk signs an individual SSE chunk for streaming responses.
// Returns the chunk with a signature field appended.
//
// For streaming, we sign each chunk individually. The agent accumulates
// chunk hashes to compute a final session hash.
func SignStreamingChunk(
	chunkData []byte,
	chunkIndex int,
	model string,
	wallet interfaces.PrKeyProvider,
) (signedData []byte, err error) {
	if wallet == nil {
		return chunkData, nil
	}

	privKeyHex, err := wallet.GetPrivateKey()
	if err != nil {
		return chunkData, nil // Fail open — return unsigned
	}

	privKey, err := crypto.ToECDSA([]byte(privKeyHex))
	if err != nil {
		return chunkData, nil
	}

	// Hash this chunk
	hash := sha256.Sum256(chunkData)
	chunkHash := hex.EncodeToString(hash[:])

	// Sign: chunkHash | chunkIndex | model
	signingPayload := fmt.Sprintf("0x%s|%d|%s", chunkHash, chunkIndex, model)
	payloadHash := crypto.Keccak256Hash([]byte(signingPayload))
	sigBytes, err := crypto.Sign(payloadHash.Bytes(), privKey)
	if err != nil {
		return chunkData, nil
	}

	// For SSE: add a signature comment line before the data line
	// data: {"id":"...","choices":[...]}\n
	// becomes:
	// x-sig: 0x...\n
	// data: {"id":"...","choices":[...]}\n
	sigLine := fmt.Sprintf("x-sig: 0x%s\n", hex.EncodeToString(sigBytes))
	signedData = append([]byte(sigLine), chunkData...)
	return signedData, nil
}

// VerifyResponseSignature verifies a provider's response signature.
// Used by the agent to verify the provider actually signed this response.
//
// This function is also available on the agent side (TypeScript version
// in secure-channel.ts uses ethers.js verifyMessage).
func VerifyResponseSignature(sig *ResponseSignature) (bool, error) {
	// Reconstruct signing payload
	signingPayload := fmt.Sprintf("%s|%s|%s", sig.ResponseHash, sig.Model, sig.Timestamp)
	payloadHash := crypto.Keccak256Hash([]byte(signingPayload))

	// Decode signature
	sigBytes, err := hex.DecodeString(sig.Signature[2:]) // strip 0x
	if err != nil {
		return false, err
	}

	// Recover public key from signature
	pubKey, err := crypto.SigToPub(payloadHash.Bytes(), sigBytes)
	if err != nil {
		return false, err
	}

	// Check recovered address matches claimed provider address
	recoveredAddr := crypto.PubkeyToAddress(*pubKey)
	return recoveredAddr.Hex() == sig.ProviderAddress, nil
}
