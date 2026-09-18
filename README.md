<div align="right">
  <strong>English</strong> | <a href="./README_zh.md">简体中文</a>
</div>

# LicenKit

> Modern, lightweight, high-performance API-First software licensing hub & key generator.

---

> [!WARNING]
> 🚧 **Active Development (Work in Progress / Alpha)**  
> Core modules and API specifications are under rapid iteration. As the project is under active development, documentation may occasionally lag behind code changes. We appreciate your patience and understanding!

---

## 🎯 Vision & Goals

**LicenKit** is designed for indie hackers, micro-SaaS founders, and commercial software teams as a modern, truly self-hostable open-source licensing solution at near-zero operational cost.

- **API-First & Edge-Native**: Built natively on Cloudflare Workers and D1, delivering millisecond latency globally with effortless, serverless self-hosting.
- **Modern Cryptographic Security**: Built-in WebCrypto native Ed25519 asymmetric signatures and AES-256-GCM envelope encryption, supporting both online heartbeat verification and offline air-gapped cryptographic validation.
- **Complete License Lifecycle**: Comprehensive coverage of software products, flexible licensing policies (lifetime, subscription, grace periods, machine concurrency limits), license key generation & distribution, hardware fingerprint binding, trial abuse prevention, and key revocation/rotation.
- **Automated Payment & Fulfillment**: Deeply integrates with merchant of record and payment platforms like Paddle and Stripe via webhooks for automated key issuance, subscription status sync, and upcoming cross-platform client SDKs.

---

## 🏗️ Architecture

LicenKit is organized as a modern **Monorepo**:

```text
licenkit/
├── apps/
│   ├── server/        # Core licensing & API engine (Hono + Cloudflare Workers + D1 + Drizzle ORM)
│   ├── web/           # Modern admin dashboard SPA (React 19 + Tailwind CSS v4 + Vite)
│   └── cli/           # Cross-platform licensing & offline verification CLI (Node.js + WebCrypto Ed25519)
├── docs/
│   ├── en/            # English documentation
│   ├── zh-CN/         # Chinese documentation
│   ├── schemas/       # Database DDL & structural schemas
│   └── proposals/     # Architectural proposals & RFCs (archive inside)
└── scripts/           # Maintenance and utility scripts
```

- **Runtime / Infra**: [Cloudflare Workers](https://workers.cloudflare.com/), [Cloudflare D1](https://developers.cloudflare.com/d1/), [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- **Backend**: [Hono](https://hono.dev/), [Drizzle ORM](https://orm.drizzle.team/), WebCrypto API (Ed25519, AES-256-GCM, PBKDF2)
- **Frontend**: [React 19](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS v4](https://tailwindcss.com/), [Lucide Icons](https://lucide.dev/)
- **CLI**: [Node.js](https://nodejs.org/), [cac](https://github.com/cacjs/cac), native WebCrypto Ed25519
- **Package Manager**: [pnpm](https://pnpm.io/) (Workspace)

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (>= 20.x)
- [pnpm](https://pnpm.io/) (>= 10.x)

### Installation & Development

1. **Clone the repository and install dependencies**:
   ```bash
   git clone https://github.com/your-org/licenkit.git
   cd licenkit
   pnpm install
   ```

2. **Start the local full-stack development environment**:
   ```bash
   # Concurrently starts Server API (port 8787) and Web Dashboard (port 5173)
   pnpm dev
   ```

3. **Run individual modules**:
   ```bash
   pnpm dev:server   # Start backend API engine only
   pnpm dev:web      # Start web dashboard only
   pnpm dev:cli      # Run client CLI tool
   ```

4. **Type check & Build**:
   ```bash
   pnpm typecheck    # Global TypeScript type checking
   pnpm build        # Global production build
   ```

---

## 📖 Documentation

For deep dives into the system architecture and implementation roadmap, refer to the documents in `docs/`:

> [!NOTE]
> 💡 *As the project is currently in the **Active Development** stage, documentation updates may occasionally lag behind fast-moving code changes. Please feel free to open an issue or consult the latest codebase if you encounter discrepancies.*

- [Roadmap & WBS](./docs/en/development_plan.md) ([中文版](./docs/zh-CN/development_plan.md))
- [Backend Architecture & Cryptography](./docs/en/backend_architecture.md) ([中文版](./docs/zh-CN/backend_architecture.md))
- [Database Schema & Design](./docs/en/database_design.md) ([中文版](./docs/zh-CN/database_design.md))
- [RESTful API Specification](./docs/en/api_specification.md) ([中文版](./docs/zh-CN/api_specification.md))
- [Configuration, Secrets & Keys](./docs/en/configuration_and_keys.md) ([中文版](./docs/zh-CN/configuration_and_keys.md))
- [Local Development Guide](./docs/en/local_development_guide.md) ([中文版](./docs/zh-CN/local_development_guide.md))
