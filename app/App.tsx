import { View, ActivityIndicator, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";

import { useAuth } from "./src/hooks/useAuth";
import { SignInScreen } from "./src/components/SignInScreen";
import { HomeScreen } from "./src/components/HomeScreen";
import { theme } from "./src/theme";

export default function App() {
  const { status, user, error, requestMagicLink, signOut } = useAuth();

  if (status === "loading") {
    return (
      <View style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (status === "signed-out" || !user) {
    return (
      <>
        <StatusBar style="light" />
        <SignInScreen onSubmit={requestMagicLink} error={error} />
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <HomeScreen user={user} onSignOut={signOut} />
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: theme.colors.bg0,
    alignItems: "center",
    justifyContent: "center",
  },
});
