# FINPUB｜金融酒馆

Browser-local discrete-time exchange simulator built with React and TypeScript. No backend, database, WebSocket, or external market feed is used.

```bash
npm install
npm run dev
```

Production verification:

```bash
npm test
npm run build
```

The market initializes from a configurable pre-market screen. Every running second processes cancellations, deterministic events, NPC decisions, newly queued orders, matching, account settlement, and full-market snapshots in that order.
