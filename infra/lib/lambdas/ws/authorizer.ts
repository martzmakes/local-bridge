// Lambda REQUEST authorizer on the WebSocket $connect route. The machine sends
// its signed assertion as "Authorization: Bearer <jwt>" on the upgrade request.
import { verifyDeviceAssertion } from "../bridge/device-auth";
import { getStore, logEvent } from "../bridge/runtime";

interface AuthorizerEvent {
  methodArn: string;
  headers?: Record<string, string | undefined>;
}

function policy(principalId: string, effect: "Allow" | "Deny", resource: string, context?: Record<string, string>) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: resource }],
    },
    context,
  };
}

export const handler = async (event: AuthorizerEvent) => {
  const headers = event.headers ?? {};
  const raw = headers.Authorization ?? headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) {
    logEvent("device_auth_denied", { reason: "no_bearer" });
    return policy("anonymous", "Deny", event.methodArn);
  }
  const store = getStore();
  const result = await verifyDeviceAssertion(match[1], {
    getMachine: (uid, id) => store.forTenant(uid).getMachine(id),
    claimJti: (jti) => store.claimJti(jti),
  });
  if (!result.ok) {
    logEvent("device_auth_denied", { reason: result.reason });
    return policy("anonymous", "Deny", event.methodArn);
  }
  logEvent("device_auth_ok", { uid: result.uid, machine: result.machine, kid: result.kid });
  return policy(`${result.uid}/${result.machine}`, "Allow", event.methodArn, { uid: result.uid, machine: result.machine, kid: result.kid });
};
