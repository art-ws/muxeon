// The panel (§12.7): login → [peer list | chat]. State lives in store.ts (pure,
// tested); this layer is wiring and DOM. Agent text renders as TEXT ONLY —
// React's default escaping is the §12.6 XSS stance, no HTML/markdown injection.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChatView } from "./Chat";
import { CommandFanout } from "./CommandFanout";
import { Composer, type Draft } from "./Composer";
import { PeerList } from "./PeerList";
import { SettingsView } from "./Settings";
import { TransportView } from "./Transport";
import * as api from "./api";
import {
  DEFAULT_LANG,
  type Lang,
  type Messages,
  loadLang,
  parseMessages,
  saveLang,
  translator,
} from "./i18n";
import { I18nContext, useT } from "./i18n-context";
import { authMode, instanceName } from "./instance";
import { agentColor } from "./palette";
import { chatSurface, hasConsole } from "./peer-surface";
import { loadPref, savePref } from "./prefs";
import { type Route, parseRoute, routeHash } from "./route";
import type { ServerInfo } from "./server-info";
import { SESSION_CHECK_MS, renewDueAt } from "./session";
import {
  type PanelState,
  applyEvent,
  applyHistoryPage,
  applyOutgoing,
  applyPeers,
  initialState,
  selectPeer,
  threadOf,
} from "./store";
import { type Theme, applyTheme, loadTheme } from "./theme";
import { type ChatRecord, type PanelEvent, peerKind } from "./types";
import { loadVisibility, saveVisibility, visiblePeers } from "./visibility";

type Action =
  | { kind: "peers"; peers: Parameters<typeof applyPeers>[1] }
  | { kind: "select"; peer: string | undefined }
  | { kind: "page"; peer: string; page: Parameters<typeof applyHistoryPage>[2] }
  | { kind: "outgoing"; record: ChatRecord }
  | { kind: "event"; event: PanelEvent };

// The panel is one operator (§12.1): anything that is not a listed peer is "us".
const makeReducer =
  (isPeer: (name: string) => boolean) =>
  (state: PanelState, action: Action): PanelState => {
    switch (action.kind) {
      case "peers":
        return applyPeers(state, action.peers);
      case "select":
        return selectPeer(state, action.peer);
      case "page":
        return applyHistoryPage(state, action.peer, action.page);
      case "outgoing":
        return applyOutgoing(state, action.record);
      case "event":
        return applyEvent(state, action.event, (name) => !isPeer(name));
      default:
        return state;
    }
  };

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | undefined>(undefined);
  // Theme (§12.7, FR-59): light by default, persisted choice wins; the switch
  // lives on the settings page (T110) and flips <html data-theme>.
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  useEffect(() => applyTheme(theme), [theme]);
  // Auto-scroll (FR-62): a GLOBAL follow switch — ON keeps every feed (chats,
  // transport) pinned to the newest message; OFF (the default) keeps the
  // stick-when-near-bottom behavior. Persisted across reloads (FR-72).
  const [follow, setFollow] = useState(() => loadPref("follow", false));
  useEffect(() => savePref("follow", follow), [follow]);
  // Raw transport mode (FR-88, §14.3): a GLOBAL composer mode — ON sends typed
  // text to the agent's terminal as-is and shows its console as the reply; OFF
  // (the default) is the normal chat. Persisted across reloads (FR-72).
  const [raw, setRaw] = useState(() => loadPref("raw", false));
  useEffect(() => savePref("raw", raw), [raw]);
  // Sidebar (FR-68): the logo is the collapse toggle — collapsed shows the icon
  // rail, expanded the text rows; expanded by default, persisted (FR-72).
  const [collapsed, setCollapsed] = useState(() => loadPref("collapsed", false));
  useEffect(() => savePref("collapsed", collapsed), [collapsed]);
  // Sidebar layout (§15): ON shows the classic FLAT agent list (no groups/tags);
  // OFF (the default) shows the group tree + Tags section. Persisted (FR-72).
  const [flatPeers, setFlatPeers] = useState(() => loadPref("flat-peers", false));
  useEffect(() => savePref("flat-peers", flatPeers), [flatPeers]);
  // Token-usage display: ON by default; OFF hides the chat-header token meter for a
  // lighter interface. Persisted (FR-72).
  const [showTokens, setShowTokens] = useState(() => loadPref("show-tokens", true));
  useEffect(() => savePref("show-tokens", showTokens), [showTokens]);
  // Instance label (FR-90): the connector injected it into the shell; static post-load.
  const [brandName] = useState(instanceName);
  // Global message filter (T97, FR-71): one topbar field filters EVERY list —
  // chats and the transport feed; the views count what it hides.
  const [query, setQuery] = useState("");
  // UI language (T114, FR-78): English is the source and the default; a
  // non-English choice lazily fetches its OPTIONAL dictionary — a missing or
  // broken file just leaves the interface in English.
  const [lang, setLang] = useState<Lang>(() => loadLang());
  useEffect(() => saveLang(lang), [lang]);
  const [messages, setMessages] = useState<Messages | undefined>(undefined);
  useEffect(() => {
    if (lang === DEFAULT_LANG) {
      setMessages(undefined);
      return;
    }
    let stale = false; // a quick double-switch must not apply the older fetch
    void fetch(`assets/i18n/${lang}.json`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((raw: unknown) => {
        if (!stale) setMessages(raw === undefined ? undefined : parseMessages(raw));
      })
      .catch(() => {
        if (!stale) setMessages(undefined);
      });
    return () => {
      stale = true;
    };
  }, [lang]);
  const t = translator(messages);
  return (
    <I18nContext.Provider value={t}>
      <div className="app">
        <header className="topbar">
          {/* the designer's logo as-is (T88); the click collapses/expands the sidebar (FR-68).
              The configuration label (FR-90) sits next to it when set. */}
          <div className="topbar-brand">
            <button
              type="button"
              className="brand-button"
              title={collapsed ? t("Expand the sidebar") : t("Collapse the sidebar")}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            >
              <img className="brand-logo" src="assets/logo.png" alt="TEAM AI" />
            </button>
            {brandName !== "" && (
              <span className="brand-name" title={brandName}>
                {brandName}
              </span>
            )}
          </div>
          {authed === true && (
            <span className="topbar-search">
              <input
                type="search"
                placeholder={t("Filter messages…")}
                aria-label={t("Filter messages in chats and transport")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query !== "" && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label={t("Clear the message filter")}
                  onClick={() => setQuery("")}
                >
                  ×
                </button>
              )}
            </span>
          )}
        </header>
        {authed === true ? (
          <Panel
            follow={follow}
            onFollow={setFollow}
            theme={theme}
            onTheme={setTheme}
            lang={lang}
            onLang={setLang}
            raw={raw}
            onRaw={setRaw}
            flat={flatPeers}
            onFlat={setFlatPeers}
            showTokens={showTokens}
            onShowTokens={setShowTokens}
            collapsed={collapsed}
            query={query}
            onAuthLost={() => setAuthed(false)}
          />
        ) : (
          <Login
            checking={authed === undefined}
            onProbe={(ok) => setAuthed(ok)}
            onLoggedIn={() => setAuthed(true)}
          />
        )}
      </div>
    </I18nContext.Provider>
  );
}

function Login(props: {
  checking: boolean;
  onProbe: (authed: boolean) => void;
  onLoggedIn: () => void;
}): React.JSX.Element {
  const t = useT();
  const [password, setPassword] = useState("");
  const [user, setUser] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Users mode (§17.2): the served shell says so, so the form asks WHO is
  // signing in; a legacy single-operator panel keeps the password-only card.
  const usersMode = authMode() === "users";

  useEffect(() => {
    if (!props.checking) return;
    void fetch("api/peers").then((response) => props.onProbe(response.ok));
  }, [props.checking, props.onProbe]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.login(password, usersMode ? user : undefined);
      props.onLoggedIn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "login failed");
    } finally {
      setBusy(false);
    }
  };

  if (props.checking) return <div className="login-screen">…</div>;
  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <img className="login-logo" src="assets/logo.png" alt="TEAM AI" />
        {usersMode && (
          <input
            type="text"
            autoComplete="username"
            placeholder={t("User")}
            value={user}
            onChange={(event) => setUser(event.target.value)}
          />
        )}
        <input
          type="password"
          autoComplete="current-password"
          placeholder={t(usersMode ? "Password" : "Operator password")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="submit"
          disabled={busy || password.length === 0 || (usersMode && user.length === 0)}
        >
          {t("Sign in")}
        </button>
        {error !== undefined && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

/** Live transport rows kept in memory (FR-48); older ones page from the log. */
const TRANSPORT_LIVE_CAP = 500;

function Panel(props: {
  follow: boolean;
  onFollow: (follow: boolean) => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  lang: Lang;
  onLang: (lang: Lang) => void;
  /** Raw transport mode (FR-88, §14.3): drives the composer and the send call. */
  raw: boolean;
  onRaw: (raw: boolean) => void;
  /** Sidebar layout (§15): true = flat agent list, false = group tree + Tags. */
  flat: boolean;
  onFlat: (flat: boolean) => void;
  /** Token-usage display: true (default) shows the chat-header token meter, false hides it. */
  showTokens: boolean;
  onShowTokens: (show: boolean) => void;
  collapsed: boolean;
  /** Global message filter (FR-71) — applied by the chat and transport views. */
  query: string;
  onAuthLost: () => void;
}): React.JSX.Element {
  const t = useT();
  const peerSet = useRef(new Set<string>());
  const reducer = useRef(makeReducer((name) => peerSet.current.has(name))).current;
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The transport view (FR-48): live rows from the WS push; the page fetch
  // inside TransportView covers history and reconnect catch-up.
  const [transportLive, setTransportLive] = useState<readonly ChatRecord[]>([]);
  // Routing (FR-60): the hash is the source of truth for the open view — deep
  // links and back/forward come for free; navigation just writes the hash.
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The operator's own name (FR-68) — the sidebar account button. In users mode
  // this is the logged-in user (§17.7), with their role (FR-131); their own row
  // (self-chat, FR-128) arrives inside `peers` like any other.
  const [operator, setOperator] = useState<string | undefined>(undefined);
  const [role, setRole] = useState<"admin" | "user" | undefined>(undefined);

  // Agent visibility (T110, FR-76): the settings checklist decides which agents
  // the sidebar shows — "all" (default) or only the picked set; persisted.
  const [visibility, setVisibility] = useState(() => loadVisibility());
  useEffect(() => saveVisibility(visibility), [visibility]);

  // The sidebar Transport entry (T115): shown by default, hideable from the
  // settings page; the direct #/transport URL keeps working either way.
  const [showTransport, setShowTransport] = useState(() => loadPref("transport", true));
  useEffect(() => savePref("transport", showTransport), [showTransport]);
  // Server build info (FR-91) for the Settings footer — static, fetched once.
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>(undefined);
  useEffect(() => {
    void api
      .fetchServerInfo()
      .then(setServerInfo)
      .catch(() => undefined);
  }, []);

  // Session auto-renewal (T125, FR-86): learn when the token dies, slide it
  // forward at the half-life of the window — an open panel never logs itself
  // out, a closed one expires on the server's schedule. A 401 on renew means
  // the session is already gone — the regular auth-lost path takes over.
  useEffect(() => {
    let dueAt = Number.POSITIVE_INFINITY;
    const learn = (expiresAt: number | undefined): void => {
      if (typeof expiresAt === "number") dueAt = renewDueAt(Date.now(), expiresAt);
    };
    void api
      .sessionInfo()
      .then((info) => learn(info.expiresAt))
      .catch(() => undefined); // a hiccup — the next 401 lands on login anyway
    const tick = (): void => {
      if (Date.now() < dueAt) return;
      dueAt = Number.POSITIVE_INFINITY; // one renewal in flight at a time
      api
        .renewSession()
        .then((renewed) => learn(renewed.expiresAt))
        .catch((failure) => {
          if (failure instanceof api.ApiError && failure.status === 401) props.onAuthLost();
        });
    };
    const timer = setInterval(tick, SESSION_CHECK_MS);
    window.addEventListener("focus", tick); // a woken laptop renews immediately
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [props.onAuthLost]);

  // initial peers + the live feed
  useEffect(() => {
    void api.fetchPeers().then(({ peers, operator: me, role: myRole }) => {
      for (const peer of peers) peerSet.current.add(peer.name);
      setOperator(me);
      setRole(myRole);
      dispatch({ kind: "peers", peers });
    });
    return api.connectFeed({
      onEvent: (event) => {
        if (event.type === "transport") {
          setTransportLive((live) => [...live.slice(-(TRANSPORT_LIVE_CAP - 1)), event.record]);
          return;
        }
        dispatch({ kind: "event", event });
      },
      onAuthLost: props.onAuthLost,
    });
  }, [props.onAuthLost]);

  // The route drives the store: an open chat selects the peer (badge + server
  // watermark) and lazily loads its first history page; home/transport deselect.
  useEffect(() => {
    if (route.view !== "chat") {
      dispatch({ kind: "select", peer: undefined });
      return;
    }
    const peer = route.peer;
    dispatch({ kind: "select", peer });
    // groups/tags (§15) have no unread watermark — skip markRead for a known
    // broadcast target; an unknown/not-yet-loaded name is treated as an agent.
    // A user chat (§17.7) DOES have one: a colleague's message is unread exactly
    // like an agent's, so opening it must move the server watermark too.
    const known = stateRef.current.peers.find((info) => info.name === peer);
    const kind = known === undefined ? "agent" : peerKind(known);
    if (kind === "agent" || kind === "user") void api.markRead(peer);
    if (!threadOf(stateRef.current, peer).loaded) {
      void api.fetchHistory(peer).then((page) => dispatch({ kind: "page", peer, page }));
    }
  }, [route]);

  const navigate = useCallback((target: Route): void => {
    location.hash = routeHash(target);
  }, []);

  const loadOlder = useCallback((peer: string): void => {
    const cursor = threadOf(stateRef.current, peer).nextBefore;
    if (cursor === undefined) return;
    void api.fetchHistory(peer, cursor).then((page) => dispatch({ kind: "page", peer, page }));
  }, []);

  const raw = props.raw;
  const send = useCallback(
    async (to: string, draft: Draft): Promise<void> => {
      const id = api.newMessageId(); // §10.9: the client owns the retry id
      const blobs = draft.blobs.map((blob) => blob.id);
      await api.sendMessage({
        to,
        id,
        ...(draft.text !== "" ? { text: draft.text } : {}),
        ...(blobs.length > 0 ? { blobs } : {}),
        ...(raw ? { raw: true } : {}), // raw mode: the text reaches the terminal as-is (§14)
      });
      dispatch({
        kind: "outgoing",
        record: {
          id,
          from: "(me)", // a non-peer name — the reducer treats it as our side
          to,
          kind: "message",
          ts: Date.now(),
          payload:
            blobs.length === 0
              ? draft.text
              : {
                  ...(draft.text !== "" ? { text: draft.text } : {}),
                  blobs: draft.blobs.map((blob) => ({
                    blob: blob.id,
                    name: blob.name,
                    mime: blob.mime,
                    size: blob.size,
                  })),
                },
          ...(raw ? { raw: true } : {}), // the bubble renders raw text as-is (§14.3)
        },
      });
    },
    [raw],
  );

  // Logout (FR-68): revoke server-side, then drop to the login screen; a failed
  // call (expired session) still lands on login — that IS the logged-out state.
  const logout = useCallback((): void => {
    void api
      .logout()
      .catch(() => undefined)
      .then(props.onAuthLost);
  }, [props.onAuthLost]);

  const openChat = route.view === "chat" ? route.peer : undefined;
  const openPeer =
    openChat !== undefined ? state.peers.find((info) => info.name === openChat) : undefined;
  // Groups & tags (§15) are input-only broadcast targets: no live status (so no
  // "thinking" wash) and raw mode is server-rejected — the composer forces it off.
  const openIsBroadcast = openPeer !== undefined && chatSurface(openPeer) === "broadcast";
  // Console-backed affordances (raw mode §14, slash commands FR-66, Screen Live
  // FR-102) exist only behind an AGENT: a person (§17.7) has no terminal, so the
  // server would reject them — the composer must not offer them at all.
  const openHasConsole = hasConsole(openPeer);
  // Command-fanout modal (§15.8, FR-115): launched from a group/tag chat, seeded
  // with that target; closed automatically when the open chat changes.
  const [commandOpen, setCommandOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to CLOSE the modal whenever the open chat changes (the body doesn't read openChat, it reacts to it)
  useEffect(() => setCommandOpen(false), [openChat]);
  return (
    <div className="panel">
      <PeerList
        peers={visiblePeers(state.peers, visibility)}
        selected={openChat}
        onSelect={(peer) => navigate({ view: "chat", peer })}
        transportSelected={route.view === "transport"}
        /* The journal is an admin capability (§17.7, FR-131): a plain user gets no
           entry at all — the endpoint answers 403 for them anyway. */
        {...(showTransport && role !== "user"
          ? { onTransport: () => navigate({ view: "transport" }) }
          : {})}
        flat={props.flat}
        collapsed={props.collapsed}
        operator={operator}
        onLogout={logout}
        onSettings={() => navigate({ view: "settings" })}
      />
      {route.view === "transport" ? (
        <main className="chat-pane">
          <TransportView
            live={transportLive}
            follow={props.follow}
            query={props.query}
            {...(route.from !== undefined ? { from: route.from } : {})}
            {...(route.to !== undefined ? { to: route.to } : {})}
            // FR-85: the selection PROJECTS into the URL and round-trips back via
            // the route; replace() — filter toggles must not pile up in history
            onFilters={(from, to) =>
              location.replace(
                routeHash({
                  view: "transport",
                  ...(from.length > 0 ? { from } : {}),
                  ...(to.length > 0 ? { to } : {}),
                }),
              )
            }
          />
        </main>
      ) : route.view === "settings" ? (
        <main className="chat-pane">
          {/* the checklist gets the FULL list of AGENTS — hidden agents must stay
              pickable; groups/tags (§15) are not per-agent visibility toggles */}
          <SettingsView
            follow={props.follow}
            onFollow={props.onFollow}
            theme={props.theme}
            onTheme={props.onTheme}
            lang={props.lang}
            onLang={props.onLang}
            transport={showTransport}
            onTransport={setShowTransport}
            raw={props.raw}
            onRaw={props.onRaw}
            flat={props.flat}
            onFlat={props.onFlat}
            showTokens={props.showTokens}
            onShowTokens={props.onShowTokens}
            peers={state.peers.filter(
              // local agents only — a federated peer (§18.4) is not a visibility toggle
              (peer) => peerKind(peer) === "agent" && peer.server === undefined,
            )}
            visibility={visibility}
            onVisibility={setVisibility}
            serverInfo={serverInfo}
          />
        </main>
      ) : openChat !== undefined ? (
        /* the agent's accent tints the whole pane (FR-73): a soft gradient
           normally, an animated one while the agent is thinking (busy) */
        <main
          className={`chat-pane tinted${openPeer?.status === "busy" ? " thinking" : ""}`}
          style={{ "--agent-color": agentColor(openChat, openPeer?.color) } as React.CSSProperties}
        >
          <ChatView
            peer={openPeer}
            thread={threadOf(state, openChat)}
            phases={state.phases}
            isPeer={(name) => peerSet.current.has(name)}
            onLoadOlder={() => loadOlder(openChat)}
            follow={props.follow}
            showTokens={props.showTokens}
            query={props.query}
            anchor={route.view === "chat" ? route.message : undefined}
          />
          {openIsBroadcast && (
            /* a group/tag can't receive a one-directional broadcast COMMAND on the
               message path — the slash-command fan-out (§15.8, FR-115) runs it on
               the INTERSECTION of the target + any extra selectors, per-agent */
            <div className="broadcast-actions">
              <button type="button" className="cmdfan-launch" onClick={() => setCommandOpen(true)}>
                {t("⌘ Slash command")}
              </button>
            </div>
          )}
          <Composer
            key={openChat}
            peer={openChat}
            onSend={(draft) => send(openChat, draft)}
            commands={openHasConsole ? (openPeer?.commands ?? []) : []}
            onCommand={(slash) => api.runAgentCommand(openChat, slash)}
            /* no terminal behind a group/tag (§15) or a person (§17.7) — raw mode
               is off there (the server rejects it anyway) */
            raw={openHasConsole ? raw : false}
            /* the pause note (§16.6, FR-120); a group/tag is never paused (§16.1) */
            paused={openIsBroadcast ? false : openPeer?.paused === true}
            /* …but for a person the same flag is their do-not-disturb (§17.8) */
            dnd={chatSurface(openPeer) === "person"}
          />
          {commandOpen && (
            <CommandFanout
              peers={state.peers}
              initialSelector={openChat}
              onClose={() => setCommandOpen(false)}
            />
          )}
        </main>
      ) : (
        <main className="chat-pane empty">{t("Select an agent to start chatting")}</main>
      )}
    </div>
  );
}
