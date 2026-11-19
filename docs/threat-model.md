# Local Bridge threat model

Local Bridge relays calls between authenticated remote MCP clients and tools running under the Mac user's permissions. A deployment operator controls AWS infrastructure, signing secrets, email eligibility, audit retention, and access to transient call records. Self-hosting places that trust boundary in the operator's AWS account.

| Boundary | Controls and assumptions |
| --- | --- |
| Remote client to cloud | HTTPS, OAuth with PKCE, a sign-in allowlist, tenant-scoped connector lookup, tool policy, quotas and deadlines. A connector URL is an identifier. Access requires a valid token. |
| Cloud to Mac | The daemon opens a TLS WebSocket. A Lambda authorizer verifies a short-lived Ed25519 assertion and checks its unique ID for replay. AWS holds the public device key. |
| Mac to MCP server | The app starts the local servers you configure. Only enabled tools are advertised and forwarded. Local servers run with the Mac user's permissions and can access resources the user grants to the app. Install servers you trust. |
| Cloud data storage | DynamoDB stores tenant state and short-lived call and result records. Audit records contain metadata and keyed argument digests. Cloud operators with access to the relevant resources can read in-flight content. |

An owner connector can use the tools exposed on its endpoint. Scoped agents start with no tool permissions. Changes in the app or to a scoped agent's cloud policy affect future requests. The bridge fails calls when the Mac is offline and keeps deadlines for in-flight requests.

When changing backends, the Mac app clears the previous machine registration from its local configuration and turns its servers off. After signing in to the new backend, review and re-enable the servers you want to share. If you suspect a compromised connector or device, see the [operator commands](operations.md) for revoking an agent or removing a device.
