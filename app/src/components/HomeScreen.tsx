import { View, Text, Pressable, StyleSheet } from "react-native";
import { theme } from "../theme";

interface Props {
  user: { email: string };
  onSignOut: () => void;
}

const MCP_URL = "https://bridge.martzmakes.com/mcp";

export function HomeScreen({ user, onSignOut }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Local Bridge</Text>
      <Text style={styles.body}>
        Remote MCP server that forwards tool calls to MCP servers on my Macs. Add this URL as a
        connector in Claude and sign in with the magic link once:
      </Text>
      <Text selectable style={styles.code}>{MCP_URL}</Text>
      <Text style={styles.body}>Signed in as {user.email}</Text>
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
