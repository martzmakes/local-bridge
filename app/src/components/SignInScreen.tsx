import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";

interface Props {
  onSubmit: (email: string) => Promise<{ ok: boolean; error?: string }>;
  error?: string | null;
}

export function SignInScreen({ onSubmit, error }: Props) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!email.trim()) return;
    setSubmitting(true);
    const result = await onSubmit(email.trim().toLowerCase());
    setSubmitting(false);
    if (result.ok) setSent(true);
  };

  if (sent) {
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.eyebrow}>SIGN IN</Text>
          <Text style={styles.heading}>Check your email</Text>
          <Text style={styles.body}>
            Sent a sign-in link to {email}. Expires in 15 minutes.
          </Text>
          <Pressable style={styles.linkButton} onPress={() => setSent(false)}>
            <Text style={styles.linkText}>Use a different email</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>SIGN IN</Text>
        <Text style={styles.heading}>Sign in to {theme.colors.brandName}</Text>
        <Text style={styles.body}>
          Enter your email. No passwords — we'll send a one-time sign-in link.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={theme.colors.fg4}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          <Text style={styles.buttonText}>
            {submitting ? "Sending…" : "Send sign-in link"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg0,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.space.s6,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.line2,
    borderWidth: 1,
    borderRadius: theme.radii.r3,
    padding: theme.space.s6,
    gap: theme.space.s3,
  },
  eyebrow: {
    color: theme.colors.fg3,
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.xs,
    letterSpacing: theme.tracking.ucase,
    fontWeight: theme.fontWeights.medium,
    marginBottom: theme.space.s1,
  },
  heading: {
    color: theme.colors.fg1,
    fontFamily: theme.fonts.display,
    fontSize: theme.fontSizes.xl2,
    lineHeight: theme.lineHeights.xl2,
    fontWeight: theme.fontWeights.semi,
    letterSpacing: theme.tracking.tight,
  },
  body: {
    color: theme.colors.fg2,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.md,
    lineHeight: theme.lineHeights.md,
    letterSpacing: theme.tracking.snug,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    color: theme.colors.fg1,
    borderColor: theme.colors.line2,
    borderWidth: 1,
    borderRadius: theme.radii.r2,
    paddingHorizontal: theme.space.s3,
    paddingVertical: theme.space.s3,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.lg,
    marginTop: theme.space.s2,
  },
  error: {
    color: theme.colors.danger,
    fontFamily: theme.fonts.mono,
    fontSize: theme.fontSizes.sm,
  },
  button: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
    borderWidth: 1,
    borderRadius: theme.radii.r2,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space.s5,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: "#fff",
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.base,
    fontWeight: theme.fontWeights.medium,
    letterSpacing: theme.tracking.snug,
  },
  linkButton: {
    marginTop: theme.space.s2,
    alignSelf: "flex-start",
  },
  linkText: {
    color: theme.colors.accent,
    fontFamily: theme.fonts.sans,
    fontSize: theme.fontSizes.base,
  },
});
