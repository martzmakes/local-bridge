import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";

const AUTH_API_URL =
  process.env.EXPO_PUBLIC_AUTH_API_URL || "http://localhost:4000";
const JWT_KEY = "local_bridge_jwt";

export interface AuthUser {
  email: string;
  ownedEntitlements: string[];
  createdAt: number | null;
  lastLoginAt: number | null;
}

export type AuthStatus = "loading" | "signed-out" | "signed-in";

// iOS standalone PWAs don't share localStorage with Safari, but cookies do.
// We mirror the JWT into both so the installed PWA picks up sessions.
function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days: number) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax; Secure`;
}

function deleteCookie(name: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax; Secure`;
}

async function getStoredJwt(): Promise<string | null> {
  try {
    if (Platform.OS === "web") {
      return localStorage.getItem(JWT_KEY) || getCookie(JWT_KEY);
    }
    return await SecureStore.getItemAsync(JWT_KEY);
  } catch {
    return null;
  }
}

async function setStoredJwt(jwt: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      localStorage.setItem(JWT_KEY, jwt);
      setCookie(JWT_KEY, jwt, 30);
      return;
    }
    await SecureStore.setItemAsync(JWT_KEY, jwt);
  } catch {}
}

async function clearStoredJwt(): Promise<void> {
  try {
    if (Platform.OS === "web") {
      localStorage.removeItem(JWT_KEY);
      deleteCookie(JWT_KEY);
      return;
    }
    await SecureStore.deleteItemAsync(JWT_KEY);
  } catch {}
}

function extractJwtFromUrl(url: string): string | null {
  try {
    const parsed = Linking.parse(url);
    const jwt = parsed.queryParams?.jwt;
    if (typeof jwt === "string" && jwt.length > 0) return jwt;
    return null;
  } catch {
    return null;
  }
}

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [jwt, setJwt] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchMe = useCallback(
    async (token: string): Promise<AuthUser | null> => {
      try {
        const res = await fetch(`${AUTH_API_URL}/auth/me`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        return (await res.json()) as AuthUser;
      } catch {
        return null;
      }
    },
    []
  );

  const acceptJwt = useCallback(
    async (token: string): Promise<boolean> => {
      const u = await fetchMe(token);
      if (!u) {
        await clearStoredJwt();
        setJwt(null);
        setUser(null);
        setStatus("signed-out");
        return false;
      }
      await setStoredJwt(token);
      setJwt(token);
      setUser(u);
      setStatus("signed-in");
      return true;
    },
    [fetchMe]
  );

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const stored = await getStoredJwt();
      if (stored) {
        const u = await fetchMe(stored);
        if (cancelled) return;
        if (u) {
          setJwt(stored);
          setUser(u);
          setStatus("signed-in");
          return;
        }
        await clearStoredJwt();
      }
      if (!cancelled) setStatus("signed-out");
    };

    const bootWithLink = async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          const tokenFromLink = extractJwtFromUrl(initialUrl);
          if (tokenFromLink) {
            await acceptJwt(tokenFromLink);
            return;
          }
        }
      } catch {}
      await boot();
    };

    bootWithLink();

    const sub = Linking.addEventListener("url", ({ url }) => {
      const tokenFromLink = extractJwtFromUrl(url);
      if (tokenFromLink) acceptJwt(tokenFromLink);
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [fetchMe, acceptJwt]);

  const requestMagicLink = useCallback(
    async (email: string): Promise<{ ok: boolean; error?: string }> => {
      setError(null);
      try {
        const res = await fetch(`${AUTH_API_URL}/auth/request`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = res.status === 429 ? "Too many sign-in requests. Wait a few minutes and try again." : body.error || "request_failed";
          setError(msg);
          return { ok: false, error: msg };
        }
        return { ok: true };
      } catch {
        setError("network_error");
        return { ok: false, error: "network_error" };
      }
    },
    []
  );

  const signOut = useCallback(async () => {
    await clearStoredJwt();
    setJwt(null);
    setUser(null);
    setStatus("signed-out");
  }, []);

  const deleteAccount = useCallback(async (): Promise<boolean> => {
    if (!jwt) return false;
    try {
      const res = await fetch(`${AUTH_API_URL}/auth/me`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) return false;
      await signOut();
      return true;
    } catch {
      return false;
    }
  }, [jwt, signOut]);

  return {
    status,
    jwt,
    user,
    error,
    requestMagicLink,
    signOut,
    deleteAccount,
    acceptJwt,
  };
}
