## [0.1.6](https://github.com/art-ws/teamai/compare/v0.1.5...v0.1.6) (2026-08-01)


### Changes

* **T234:** the account circle moves to the topbar's right corner

  The operator asked for the sidebar's bottom-left account menu to go away and for a bare user circle to sit in the header's right corner instead — no name, no "Account" label — opening the SAME menu on click. ([e79ba8a](https://github.com/art-ws/teamai/commit/e79ba8aa31905bbe2d7f666e0e13a9079322f319))
* **T235:** the account menu sank under the chat header

  The menu opened but its first item was painted over by the chat pane's header: .chat-header is a layer of its own (z-index 6, T116) and the popover — hanging off the topbar, which was unpositioned — competed with it directly from the root stacking context at z-index 5. ([ce575b9](https://github.com/art-ws/teamai/commit/ce575b94aaa4f72380ddd5d8457ad24caae2dc02))
* **T236:** the self-chat becomes the full mirror of a user's traffic

  FR-128 promised an aggregate inbox and the code never built one. What the operator did see there — their own outgoing messages — was a side effect of a bug: the panel calls "us" whoever is not a listed peer, but in users mode the viewer's own row IS in peers, so peerOf filed every outgoing record under the sender (the… ([b438912](https://github.com/art-ws/teamai/commit/b4389128d01330127e151f91432dd5555dcb271a))

## [0.1.5](https://github.com/art-ws/teamai/compare/v0.1.4...v0.1.5) (2026-08-01)


### Changes

* **T232:** relay mode joins two NAT-bound servers through a hub

  Two servers that cannot reach each other directly now talk through a shared hub they both import: the satellite adds publish: true to its import and the hub consents with relay: true on that accept entry — a two-sided opt-in (invariant §10.28) with both flags defaulting to false, so every existing link behaves exactly… ([719134c](https://github.com/art-ws/teamai/commit/719134c83126d8da1fb73409444eab85a9c16845))
* **T232:** the docs catch up with federation and relay (LLM.md, SECURITY, CONTRIBUTING, README)

  The agent runbook (docs/LLM.md) gains a relay subsection in step 11 — the satellite/hub configs, the two-sided opt-in rules, the mailbox behaviour, the consent warning to state to the human — plus a security-posture bullet and two troubleshooting rows (the no-grant warning and the reachability formula). ([b2862db](https://github.com/art-ws/teamai/commit/b2862dbea8c094418c57f7e780561d175827f08f))

## [0.1.4](https://github.com/art-ws/teamai/compare/v0.1.3...v0.1.4) (2026-07-31)


### Changes

* **T228:** Screen Live moves to the chat's actions menu

  Watching an agent's console observes the AGENT — it is not a way to compose a message, which is what everything else in the composer's "+" menu is for. The entry moves to the chat header's kebab, next to Reload, Shutdown and Pause, where the other agent actions already live (operator's call). ([2cba811](https://github.com/art-ws/teamai/commit/2cba8116c320b14c9d4202cf8d0adeac688a9c0a))

## [0.1.3](https://github.com/art-ws/teamai/compare/v0.1.2...v0.1.3) (2026-07-31)


### Changes

* **T217:** federation of servers

  A TEAMAI server can now export its actors and import a neighbour's — agents and users on different instances interact as if they shared one machine, addressed by email-style FQNs (`dev@hq`, chains grow right, resolve by the LAST `@` — decision §18.10-8). ([ff81829](https://github.com/art-ws/teamai/commit/ff81829327447ef2fd736e79f83e63e9c4386f71))
* **T219:** LLM.md learns federation (§18) — the runbook can now join stands

  The agent runbook stops at a single server; the product no longer does. New step 11 "Federation — joining stands (only if asked)": both sides of a link (exporter's federation{} + exported actors, importer's imports[] + the edge on the import node), the FQN naming rule, the debugging-cycle notes ($env-only tokens in bot… ([97b46ec](https://github.com/art-ws/teamai/commit/97b46ec5562273cecb6ae33797d5647e85b6708e))
* **T220:** the agent accent becomes a Gemini-style halo

  The open chat's wash turns RADIAL — brightest around the composer, melting into the background toward the edges (the reference the operator sent), still color-mix'ed with the themed --bg so both themes work. ([d2e6a8a](https://github.com/art-ws/teamai/commit/d2e6a8acd949ac526c7d70023bd0c7cf051b876c))
* **T221:** message times grow a "how long ago" tooltip

  Everywhere a message shows its clock time — chat bubbles and the transport journal — hovering now answers the question the clock alone does not: the tooltip carries the full local date-time plus a relative phrase ("5 minutes ago" / "5 минут назад", Intl.RelativeTimeFormat in the panel's language). ([c04a5fe](https://github.com/art-ws/teamai/commit/c04a5feb0622e9c2940c41ed8f6b08711ad7d11e))
* **T222:** the composer floats on frosted glass and grows in place

  Three moves from the operator's Gemini reference ([ad28275](https://github.com/art-ws/teamai/commit/ad282757a0c9c9d2ebbf1e66cbcf811158ba6493))
* **T223:** the grown composer owns the pane — Enter, one toggle, glass, edge wash

  Six panel fixes on top of T220/T222, from the operator's review ([de549af](https://github.com/art-ws/teamai/commit/de549af71fec56874fe9f51a00306056134580e9))
* **T224:** the composer's glass was trapping every full-screen overlay

  Screen Live opened as a dark plate over the composer with its dialog spilling off the card's edge. The popup was fine; its containing block was not. ([1433b69](https://github.com/art-ws/teamai/commit/1433b696b619c76c9177dda5f8988f3cb910aba9))
* **T225:** the transport journal reads like the chat — meta under the message

  The row was two columns: time and route on the left, the text hanging in the rest of the width. Long payloads — most of them, since agents talk in paragraphs — read as a narrow ribbon beside an empty gutter. ([ca5b236](https://github.com/art-ws/teamai/commit/ca5b236bff1a2eaedf6796bb27843db2c9d79a11))
* **T226:** the rail circles get a dome

  The collapsed sidebar was a column of flat discs. They now read as slightly domed: a light catches the upper left, the lower right falls off into shade, and a whisper of a drop shadow lifts them off the rail. ([67c2df8](https://github.com/art-ws/teamai/commit/67c2df86d2e3c1ba6ddff4396aec358639e0f5a7))
* **T227:** the changelog says what changed (release notes from commit bodies)

  Two releases' worth of entries read "ci: exempt package.json from the formatter" and nothing else, while eight tasks — federation among them — went out invisibly. ([9e21e74](https://github.com/art-ws/teamai/commit/9e21e746b07d479feeb1e868aa2abe5eef80fd4b))

## [0.1.2](https://github.com/art-ws/teamai/compare/v0.1.1...v0.1.2) (2026-07-31)


### Bug Fixes

* **ci:** exempt package.json from the formatter — the release job owns its style ([3848eb1](https://github.com/art-ws/teamai/commit/3848eb1ba5aac8e14e522a7cde0a21d8cdf9a966))

## [0.1.1](https://github.com/art-ws/teamai/compare/v0.1.0...v0.1.1) (2026-07-30)


### Bug Fixes

* **ci:** drop an input setup-node@v4 does not accept ([e0f60ca](https://github.com/art-ws/teamai/commit/e0f60cabe853d6fb6e8b16526396b37fd2a6a351))
