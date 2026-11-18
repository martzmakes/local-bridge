import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Linking } from "react-native";
import { theme } from "../theme";

interface Props {
  user: { email: string };
  jwt: string | null;
  onSignOut: () => void;
}

const MCP_URL = new URL("/mcp", process.env.EXPO_PUBLIC_AUTH_API_URL || "https://bridge.martzmakes.com").href;

export function HomeScreen({ user, jwt, onSignOut }: Props) {
  const [billing, setBilling] = useState<{ plan: "free" | "plus"; customer: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [billingError, setBillingError] = useState("");
  const api = new URL("/api/billing/", MCP_URL).href;

  useEffect(() => {
    if (!jwt) return;
    const controller = new AbortController();
    fetch(api + "status", { headers: { Authorization: "Bearer " + jwt }, signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(state => { if (!controller.signal.aborted) setBilling(state); })
      .catch(() => {});
    return () => controller.abort();
  }, [api, jwt]);

  async function openBilling(route: "checkout" | "portal", interval?: "monthly" | "annual") {
    if (!jwt || busy) return;
    setBusy(true);
    setBillingError("");
    try {
      const response = await fetch(api + route, {
        method: "POST",
        headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      if (!response.ok) throw new Error("Billing unavailable");
      const { url } = await response.json();
      const destination = new URL(url);
      if (destination.protocol !== "https:" || !["checkout.stripe.com", "billing.stripe.com"].includes(destination.hostname)) {
        throw new Error("Unexpected billing destination");
      }
      await Linking.openURL(destination.href);
    } catch {
      setBillingError("Couldn’t open billing. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Local Bridge</Text>
      <Text style={styles.body}>
        Remote MCP server that forwards tool calls to MCP servers on my Macs. Add this URL as a
        connector in Claude and sign in with the magic link once:
      </Text>
      <Text selectable style={styles.code}>{MCP_URL}</Text>
      <Text style={styles.body}>Signed in as {user.email}</Text>
      {billing ? <View style={styles.billing}>
        <Text style={styles.body}>Hosted plan · {billing.plan === "plus" ? "Plus" : "Free"}</Text>
        {billing.plan === "free" ? <>
          <Pressable style={styles.button} disabled={busy} onPress={() => openBilling("checkout", "monthly")}>
            <Text style={styles.buttonText}>Choose Plus monthly</Text>
          </Pressable>
          <Pressable style={styles.button} disabled={busy} onPress={() => openBilling("checkout", "annual")}>
            <Text style={styles.buttonText}>Choose Plus annually</Text>
          </Pressable>
        </> : null}
        {billing.customer ? <Pressable style={styles.button} disabled={busy} onPress={() => openBilling("portal")}>
          <Text style={styles.buttonText}>Manage billing</Text>
        </Pressable> : null}
        {billingError ? <Text style={styles.body}>{billingError}</Text> : null}
      </View> : null}
      <Pressable style={styles.button} onPress={onSignOut}>
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg0,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  title: { color: "#ffffff", fontSize: 28, fontWeight: "600" },
  body: { color: "#c9ced6", fontSize: 16, textAlign: "center", maxWidth: 480 },
  code: {
    color: theme.colors.accent,
    fontSize: 15,
    fontFamily: "monospace",
    padding: 12,
    borderWidth: 1,
    borderColor: "#2a2f38",
    borderRadius: 8,
  },
  billing: { alignItems: "center", gap: 10 },
  button: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2a2f38",
  },
  buttonText: { color: "#ffffff", fontSize: 15 },
});
