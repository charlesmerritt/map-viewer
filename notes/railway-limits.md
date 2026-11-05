# Railway limits for large Ingest

Research for [#9](https://github.com/charlesmerritt/map-viewer/issues/9), part of the map [#8](https://github.com/charlesmerritt/map-viewer/issues/8).
All sources were checked on **2026-11-05**. Railway's own limits page warns that its figures are "subject to change at any time" ([specs]).

**Which plan is this project on?** Not confirmed. The Railway CLI on the dev machine is not logged in (`railway whoami` returns `Unauthorized`), and nothing in the repo records the plan. Limits are given for **Hobby** and **Pro** below, with Free/Trial where they differ sharply.

## The numbers that matter for one 5 GiB Ingest

A 5 GiB Upload is 5,368,709,120 bytes (5.37 GB). Conversion writes a COG of similar size next to it.

| Limit | Hobby | Pro | Effect on a 5 GiB Ingest |
| --- | --- | --- | --- |
| RAM / vCPU per replica | 8 GB / 8 vCPU | 24 GB / 24 vCPU | Over the RAM limit, the process is OOM-killed ([staff-oom-2]) and then restarted under the restart policy |
| Ephemeral disk per deployment | 100 GB | 100 GB | Upload, COG and GDAL temp files fit. All of it is wiped on every redeploy |
| Volume size | 5 GB max | 50 GB default, self-serve up to 1 TB | Hobby can't hold even the Upload. Pro can hold Upload and COG |
| Request body upload time | 5 min | 5 min | **A single POST must sustain ≥ 143 Mbit/s.** It is a time limit, not a size limit |
| HTTP request total | 15 min if bytes keep flowing; 5 min idle | same | A synchronous Conversion request can't work. Use a job model |
| WebSocket | no duration or idle limit | same | Good for progress. Connections drop on every deploy |
| Private network | yes, same project and environment only | same | TiTiler can fetch Uploads over `*.railway.internal` with no egress charge, but only if it is in this project |
| Build image size | 100 GB | Unlimited | GDAL's Nix closure (~1.1–1.3 GiB) fits easily |

Two deadlines sit outside the ticket's bullets but bound the whole map. They are covered in [Adjacent findings](#adjacent-findings):

- **`railway.json` stops being read on 2026-12-01** ([cac]). That file holds this repo's `NIXPACKS` builder and `ON_FAILURE`/3 restart policy.
- **Node's own HTTP server ends any request at ~300 s by default** (`requestTimeout`) ([node-http]). This happens independently of Railway.

---

## 1. RAM and vCPU, and what happens over the limit

**Limits.** The docs' plan table gives per-service maxima that "include replica multiplication" ([plans]):

| Plan | Replicas | RAM | vCPU |
| --- | --- | --- | --- |
| Free | 1 | 0.5 GB | 1 |
| Trial | 2 | 1 GB | 2 |
| Hobby | 6 | 48 GB | 48 |
| Pro | 42 | 1 TB | 1,000 |

Divided per replica, railway.com/pricing states "Up to 48 vCPU / 48 GB RAM per service … at **8 vCPU / 8 GB RAM per replica**" for Hobby and "at **24 vCPU / 24 GB RAM per replica**" for Pro ([pricing]). The scaling docs confirm Pro: "each of your replicas can utilize up to 24 vCPU and 24GB of memory" ([scaling]). (The pricing page's Hobby card says "Up to 5 replicas", but its comparison table and the docs say 6. This doesn't matter here, because a service with a volume can't use replicas at all ([volumes-ref]).)

Railway autoscales vertically: "By default Railway will scale your service up to the specified vCPU and Memory limits of your plan" ([scaling]). Optional per-replica **Replica Limits** can cap this lower, and Railway warns that "Setting replica limits too low will cause your service to crash" ([cost]).

**Over the limit.** The docs don't describe the OOM path directly. Railway staff answers on Help Station do:

- brody (Employee, 2025-11-12): "Your worker process was terminated due to an out-of-memory (OOM) event." He adds that "our metrics polling interval is relatively long", so a fast memory spike can kill the process before the graph shows it ([staff-oom-2]).
- noahd (Employee, 2026-02-02): "by default Railway uses an "On Failure" restart policy that will automatically restart your service up to 10 times", and "If all restart attempts are exhausted, the deployment status changes to "Crashed" and you'll receive a notification" ([staff-oom-1]).

**This repo's policy.** `railway.json` sets `ON_FAILURE` with `restartPolicyMaxRetries: 3`. `On Failure` restarts only "if it stops due to an error (e.g., crashes, exits with a non-zero code)" ([restart]). Paid plans "can set any restart policy with any number of restarts". Free and Trial users get no `Always`, and `On Failure` is capped at 10 ([restart]). So an OOM-killed Conversion gets 3 restarts. After that, the deployment stays `Crashed` until someone redeploys it.

**For Ingest.** If Conversion runs inside the web service, an OOM kills the whole Node process. That takes down every in-flight Upload, every WebSocket and every byte-range read TiTiler is making. Whether a policy restart keeps the container's ephemeral files is **not documented**. The manual "Restart" action "Restarts the process within the deployment's container" ([deploy-ref]), which suggests the filesystem survives, but no primary source says the same for policy restarts after an OOM.

## 2. Ephemeral container disk

"Every service deployment has access to 1GB of ephemeral storage on the Free plan and 100GB on a paid plan. If a service deployment exceeds the maximum allowed storage, it can be forcefully stopped and redeployed" ([deploy-ref]). The plan table lists 100 GB for Hobby, Pro and Enterprise, and 1 GB for Free and Trial ([plans]).

**Can `.uploads/` hold a 5 GiB Upload plus a same-size COG during Conversion?** On Hobby or Pro, yes, with plenty of room. On Free or Trial, no: 1 GB is less than the Upload.

GDAL's COG driver needs temp space on top of input and output. With CreateCopy (the `gdal_translate -of COG` path), "overview generation uses a temporary dataset … requiring storage capacity of roughly one third of the final file size". By default that temp file sits in the output file's directory ([gdal-cog]). Rough peak for one job, as an estimate rather than a measurement: 5 GiB Upload + ~5–7 GiB COG (its overviews add size when the source had none) + ~2 GiB temp ≈ **12–15 GiB**. That leaves 100 GB room for several concurrent jobs. COGs over 4 GiB need BigTIFF. With compression, "the user must explicitly require the creation of a BigTIFF with BIGTIFF=YES" ([gdal-cog]).

**Durability.** Ephemeral disk is wiped on every new deployment: "All ephemeral storage (such as `/tmp`, etc.) will be wiped … All storage is considered ephemeral unless they're on a Railway Volume" ([metal]). Railway also starts deployments on its own, for host migration, security patches or faults. On Trial and Hobby a service "may be pre-emptively moved to a different host", and "These deployments are mandatory and cannot be opted out of" ([deploy-ref]). So Uploads in `.uploads/`, and every TiTiler layer that points at them, disappear after any git-push autodeploy or any Railway-initiated move.

## 3. Volumes

| | Hobby | Pro |
| --- | --- | --- |
| Size | 5 GB ("Up to 5 GB storage" ([pricing]); 5 GB in the plan table ([plans])) | 50 GB default; "Pro users and above can self-serve to increase their volume up to 1 TB" ([volumes-ref]) |
| Volumes per project | 10 | 20, can be increased ([volumes-ref]) |
| Price | $0.15 / GB / month, billed per minute on storage used ([plans], [volumes-ref]) | same |
| I/O | 3,000 read IOPS and 3,000 write IOPS, all sizes and plans ([volumes-ref]) | same |

Live resize "is available on all paid plans (Hobby and Pro)" and runs without downtime. A volume at 100% capacity instead gets an offline resize that "will restart your service". Downsizing isn't supported ([volumes], [volumes-ref]). The docs don't say how far a Hobby volume can be resized. Both pricing sources cap Hobby at 5 GB.

About 2–3% of each volume goes to filesystem metadata ([volumes-ref]). A 5 GB Hobby volume therefore has roughly 4.85 GB usable, which is **smaller than one 5 GiB (5.37 GB) Upload**. A Pro volume at the 50 GB default holds roughly three Upload-plus-COG jobs at the estimate above. Larger volumes cost $0.15/GB/month on what is used.

**One volume per service:** "Each service can only have a single volume" ([volumes-ref]).

**Sharing between services:** the docs never say "cannot", but each volume is created by connecting it to one selected service ([volumes]). Railway staff treat sharing as unsupported. The "Sharing volumes between services" feedback item is "under review", and brody (Employee) wrote on 2025-05-11 that there are no projects planned for it and no ETA ([vol-share]). **Treat sharing as impossible.** A separate Conversion worker can't read the web service's volume. It has to receive the bytes over the network or through a bucket.

**Redeploys:** "we prevent multiple deployments from being active and mounted to the same service. This means that there will be a small amount of downtime when re-deploying a service that has a volume attached, even if there is a healthcheck endpoint configured" ([volumes-ref]). "Replicas cannot be used with volumes" ([volumes-ref]). Volumes are "mounted to your service's container when it is started, not during build time", and also not during pre-deploy ([volumes]). They mount as root ([volumes]).

## 4. Edge proxy (public HTTP)

From Railway's public-networking Specs & Limits, "Edge Traffic" row (verbatim excerpt; the websocket-support bullet is omitted here) ([specs]):

> - Support for HTTP/1.1 and HTTP/2.
> - Idle HTTP/1.1 connections are closed after 60 seconds between requests. This does not apply to HTTP/2 or websocket connections.
> - Max 32 KB combined header size.
> - HTTP requests can run for up to 15 minutes if data keeps transferring (for example, keep-alive heartbeats), and are otherwise closed after 5 minutes with no data transferred.
> - **Request bodies must finish uploading within 5 minutes.**
> - Websocket connections are exempt from these duration and inactivity limits, and can stay open indefinitely, even while idle.

- **Maximum request duration:** 15 minutes while bytes flow. 5 minutes with no bytes.
- **Maximum request body size:** no size limit is documented. The binding limit is **time**: the body must finish uploading within 5 minutes.
- **Does a 10–40 min streaming POST of 5 GiB survive?** **No.** Finishing 5 GiB in 300 s takes a sustained ≥ 143 Mbit/s (17.9 MB/s). For scale: 5 GiB takes 71.6 min at 10 Mbit/s, 35.8 min at 20, 14.3 min at 50 and 7.2 min at 100. One 300 s window carries about 358 MiB at 10 Mbit/s, 715 MiB at 20, 1.75 GiB at 50 and 3.5 GiB at 100.
- Other limits: 10,000 concurrent connections, ~11,000 requests per second per domain, and 10,000 requests per connection ([specs]).

### Observed in this project's Railway HTTP logs (map-viewer service, 2026-11-05)

These come from the coordinator's log pull, not from a document:

1. A `POST /api/rasters` stalled after 6,388,344 bytes and ended with **HTTP 502 at `totalDuration=300000` ms**, `upstreamErrors [{"error":"i/o timeout","duration":299999}]`.
2. An earlier CONUS Upload POST moved **1,819,131,608 bytes in 132,926 ms (~13.7 MB/s)** before the client closed it (HTTP 499).

**Which documented limit fired in (1)?** Railway documents two different 5-minute rules: "closed after 5 minutes with no data transferred" (idle) and "Request bodies must finish uploading within 5 minutes" (body duration). A body that stalls early and then sits for 300 s breaks both at once, so this log can't tell them apart. The docs are clear that the body-duration rule applies on its own: **a POST that keeps streaming is still cut at 5 minutes.** Note that the `i/o timeout` was raised at the edge (`upstreamErrors`) at 299,999 ms. Node's own 300 s `requestTimeout` (see [Adjacent findings](#adjacent-findings)) is checked only every 30 s and answers 408, not a 502. The edge timer most likely fired first. That is an inference from the timings, not a documented fact.

**What (2) shows.** The edge didn't cap the body at ≥ 1.8 GB within 133 s, which matches "no documented size limit". At the observed 13.7 MB/s, though, a full 5 GiB body needs **~392 s**, past the 300 s limit. In 300 s that link carries only ~3.8 GiB. **Even this fast client could not finish a 5 GiB single POST.**

## 5. WebSockets

- **Supported?** Yes: "Support for websockets over HTTP/1.1" ([specs]).
- **Idle timeout and maximum duration?** None: "Websocket connections are exempt from these duration and inactivity limits, and can stay open indefinitely, even while idle" ([specs]). Railway's SSE-vs-WebSockets guide repeats this. It also says SSE *is* subject to the 15-minute and 5-minute-idle limits ([sse-ws]).
- **Across redeploys?** Connections drop. "WebSocket connections can still drop for other reasons, such as deploys or network interruptions, so implement reconnection logic on the client side" ([sse-ws]). Mechanics:
  - "Once the new deployment is online, the old deployment is sent a SIGTERM signal. By default, it is given **0 seconds** to gracefully shutdown before being forcefully stopped with a SIGKILL" ([deploy-ref]).
  - Overlap (`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`) and draining (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) both default to 0 and can be raised ([vars], [teardown]). The docs state **no maximum** for either.
  - If a volume is attached, deployments can't overlap, so a redeploy has a short gap with no server at all ([volumes-ref]).
  - Railway also starts redeploys on its own: pre-emptive host moves on Trial and Hobby, host maintenance ("We provide advance warning for these events") and host faults (see §2) ([deploy-ref]). The docs mention no warning for the pre-emptive moves or the faults.
  - With replicas, Railway "does not support sticky sessions" ([scaling]). A reconnecting client may land on a different replica.
- **SIGTERM never reaches this app.** `railway.json` starts the app with `pnpm start`. Railway's docs: "When you start your app with NPM, Yarn, or PNPM, the package manager becomes the main process … the service will eventually be force quit which is displayed as a sudden "crash"" ([sigterm]). To drain WebSockets cleanly, the start command must be `node server.mjs`.

## 6. Private networking

- **What it is:** services in one project and environment talk over encrypted WireGuard tunnels at `<service-name>.railway.internal`. Use `http://`, since the traffic is already encrypted ([pn], [pn-how]).
- **Scope:** "Services in **different projects** cannot communicate over the private network", and the same holds for different environments ([pn-how]). It is runtime only, not available during the build ([pn-how]).
- **Addressing:** environments created after 2025-10-16 resolve to IPv4 and IPv6. Older ("legacy") environments resolve **IPv6 only** ([pn-how]). `server.mjs` calls `listen(port)` with no host. Node then listens on `::` when IPv6 is available, which on most OSes also accepts IPv4 ([node-net]). The current server would therefore be reachable either way.
- **Cost:** "No egress costs: Internal traffic doesn't count toward egress billing" ([pn-how]). Public egress is $0.05/GB ([plans]). Every byte-range read TiTiler makes of an Upload through the public URL counts as map-viewer egress. Over the private network those reads are free.
- **Could `titiler-production-228c.up.railway.app` fetch Uploads at `http://<map-viewer-service>.railway.internal:<PORT>/api/rasters/…`?** Yes, **if and only if it is a service in the same Railway project and environment as map-viewer**. That couldn't be confirmed (CLI not logged in). The app would also need an internal base URL, separate from `PUBLIC_BASE_URL`, when it builds the `url=` it hands to TiTiler. The external `tt.d2s.org` can never use this path.
- **Buckets are not on the private network:** "Buckets are currently only accessible via public networking" ([buckets]).

## 7. Nixpacks and GDAL

**Can Nixpacks install GDAL?** Yes, as far as the sources show. Nixpacks' `nixPkgs` takes any nixpkgs attribute ("Nix packages to install"), and `nixpkgsArchive` pins the nixpkgs revision ([nixpacks-file]). `gdal` and `gdalMinimal` are both nixpkgs attributes. In this repo the change is `nixPkgs = ["nodejs_22", "gdal"]` in `[phases.setup]`. The `"..."` syntax keeps provider defaults ([nixpacks-file]). It has **not** been tested with a real build.

**Which GDAL version?** That depends on the nixpkgs archive the setup phase resolves to:

- Nixpacks' global default archive is nixpkgs `5148520b` from 2023-09-17 ([nixpacks-nix]), which has **GDAL 3.7.1** ([nixpkgs-gdal-2023]).
- For Node apps, the provider overrides the setup phase's archive by Node major: 18/20 → `ffeebf0a` (2025-01-16, GDAL 3.10.1), 22 → `e6f23dc0` (2025-06-16, GDAL 3.11.0), 24 → `23f9169c` (2025-10-10, GDAL 3.11.4) ([nixpacks-node], [nixpkgs-gdal-2025a], [nixpkgs-gdal-2025b], [nixpkgs-gdal-2025c]).
- With this repo's `engines.node: ">=18"`, current Nixpacks source picks the newest even major the range allows (24) ([nixpacks-node]). Which Nixpacks version Railway actually runs isn't stated anywhere, so the exact GDAL version is **not confirmed**. Set `nixpkgsArchive` to make it explicit.
- Every candidate is ≥ 3.1, the version that added the COG driver, and that driver "is built-in by default" ([gdal-cog]).

**Resulting image size.** No build was run, so the total image size is **not measured**. GDAL's Nix runtime closure on x86_64-linux, from Hydra builds of nixpkgs trunk ([hydra-gdal-sizes], [hydra-gdalmin-sizes], [hydra-gdal], [hydra-gdalmin]):

| Around | `gdal` closure | `gdalMinimal` closure |
| --- | --- | --- |
| 2023-09-17 (Nixpacks default archive) | 1,150 MiB | 273 MiB |
| 2025-01-16 (Node 18/20 archive) | 1,318 MiB | 517 MiB |
| 2025-06-16 (Node 22 archive) | 1,376 MiB | 570 MiB |
| 2025-10-10 (Node 24 archive) | 1,359 MiB | 568 MiB |
| 2026-10-31 (trunk today, GDAL 3.13.3) | 1,138 MiB | 604 MiB |

The image would grow by roughly 1.1–1.4 GiB, minus whatever it already shares with `nodejs_22` (glibc and similar). That is far under the 100 GB Hobby limit. Pro is unlimited, and Free/Trial allow 4 GB ([plans]). Builds aren't billed ([plans]).

**But Nixpacks is a dead end on Railway:**

- Nixpacks: "This project is currently in maintenance mode and is not under active development. We recommend using Railpack as a replacement" ([nixpacks-home]).
- "As of today, Railpack is the default builder", in Railway's changelog of 2025-09-19 ([railpack-default]). The config-as-code reference now lists only `RAILPACK` (default) and `DOCKERFILE` as builder values ([cac-ref]). The JSON schema still accepts `NIXPACKS` ([schema]).
- With Railpack, the route to GDAL is `RAILPACK_DEPLOY_APT_PACKAGES` ("Install additional Apt packages in the final image") ([railpack-env], [build-config]). Railpack images moved to Debian 13 (Trixie) in v0.37.0, released 2026-08-18 ([railpack-changelog]). Trixie ships `gdal-bin` **3.10.3** ([debian-gdal]). The image-size impact of that route was not measured.
- Railway docs don't say whether Railpack reads `nixpacks.toml`, so **not confirmed**. Railpack's changelog never mentions it ([railpack-changelog]).
- A `Dockerfile` is the third option: "Railway will always build with a Dockerfile if it finds one" ([cac-ref]).

---

## Adjacent findings

These sit outside the ticket's bullets but bound the same Upload, Conversion and WebSocket path.

1. **Config as Code (`railway.json`) is deprecated, with a hard cutoff on 2026-12-01**, 26 days from today. "Existing `railway.json` / `railway.toml` files continue to work for services that already use them until **2026-12-01** (hard cutoff). New services cannot opt into Config as Code" ([cac]). The replacement is Infrastructure as Code (`.railway/railway.ts`), migrated with `railway config migrate` ([iac]). This repo's `NIXPACKS` builder, `pnpm start` and `ON_FAILURE`/3 all live in `railway.json`. After the cutoff the dashboard settings rule, and **what builder and restart policy the dashboard will show then is not documented**. The IaC reference documents no builder selector ([iac-ref]). A new service, such as a Conversion worker, can't use `railway.json` at all.
2. **Node's HTTP server times out long requests on its own.** `server.requestTimeout` defaults to `300000` ms ("Sets the timeout value in milliseconds for receiving the entire request from the client"). When it fires, Node answers 408 and closes the connection ([node-http]). Node checks it every `connectionsCheckingInterval`, default 30,000 ms ([node-http-create]). `server.mjs` doesn't override it. A single long Upload POST therefore fails at ~300–330 s even with no Railway edge in front, as in local dev.
3. **Node 22 has no built-in WebSocket *server*.** The `WebSocket` global is "A browser-compatible implementation of {WebSocket}", a client, and stable since v22.4.0 ([node-ws]). A zero-dependency server must hand-roll RFC 6455 framing on the HTTP `upgrade` event, or the project must accept a dependency such as `ws`. This is a design input for #17.
4. **Railway Storage Buckets**, an alternative to an Upload through the edge. Buckets are private and S3-compatible, with presigned URLs and multipart uploads ([buckets]). A browser can upload straight to the bucket with a presigned URL ([buckets-up]), which skips the 5-minute edge body rule on our service. Bucket egress is free. Storage costs $0.015/GB-month. Hobby holds up to 1 TB in total and Pro is unlimited ([buckets-billing]). Buckets are public-network only ([buckets]). Railway docs **don't state a maximum object or part size**.

## Could not confirm

- **Which plan the project is on**, and **whether the Railway TiTiler is in the same project** as map-viewer. Both need a logged-in `railway status`.
- **What happens to ephemeral files after an OOM restart under the restart policy.** Undocumented.
- **How large a Hobby volume can be resized.** The docs allow live resize on Hobby but name no ceiling above 5 GB.
- **A documented maximum for draining or overlap seconds.** None found.
- **Builder and restart behaviour after the 2026-12-01 Config as Code cutoff**, for a service whose builder was set only in `railway.json`.
- **Exact GDAL version and total image size under Nixpacks on Railway.** The version depends on which Nixpacks release Railway runs, and no build was measured.
- **Whether Railpack reads `nixpacks.toml`.**
- **NixOS package search (search.nixos.org)** couldn't be read, because the page renders client-side. GDAL versions and sizes come from nixpkgs source at the pinned commits and from Hydra instead.

## Sources

All checked 2026-11-05.

- [plans]: Railway docs, Pricing Plans. https://docs.railway.com/pricing/plans
- [pricing]: Railway pricing page (Hobby/Pro cards and comparison table). https://railway.com/pricing
- [scaling]: Railway docs, Scaling. https://docs.railway.com/deployments/scaling
- [cost]: Railway docs, Cost control (Replica limits). https://docs.railway.com/pricing/cost-control
- [restart]: Railway docs, Restart Policy. https://docs.railway.com/deployments/restart-policy
- [deploy-ref]: Railway docs, Deployments reference (Ephemeral storage, Singleton deploys, Railway initiated deployments). https://docs.railway.com/deployments/reference
- [teardown]: Railway docs, Deployment Teardown. https://docs.railway.com/deployments/deployment-teardown
- [vars]: Railway docs, Variables reference (user-provided configuration variables). https://docs.railway.com/variables/reference
- [sigterm]: Railway docs, NodeJS SIGTERM Handling. https://docs.railway.com/deployments/troubleshooting/nodejs-sigterm-handling
- [staff-oom-1]: Help Station, "MySQL Behavior Upon Exceeding Memory Cap", noahd (Employee), 2026-02-02. https://station.railway.com/questions/my-sql-behavior-upon-exceeding-memory-cap-7c447520
- [staff-oom-2]: Help Station, "worker process exiting with code 137", brody (Employee), 2025-11-12. https://station.railway.com/questions/worker-process-exiting-with-code-137-ced4a258
- [volumes]: Railway docs, Using Volumes. https://docs.railway.com/volumes
- [volumes-ref]: Railway docs, Volumes reference (size limits, caveats). https://docs.railway.com/volumes/reference
- [vol-share]: Help Station feedback, "Sharing volumes between services", brody (Employee), 2025-05-11. https://station.railway.com/feedback/sharing-volumes-between-services-7ee52e9f
- [metal]: Railway docs, Railway Metal (ephemeral storage wiped on new deploys). https://docs.railway.com/platform/railway-metal
- [specs]: Railway docs, Public Networking Specs & Limits. https://docs.railway.com/networking/public-networking/specs-and-limits
- [sse-ws]: Railway guide, Choose Between SSE and WebSockets. https://docs.railway.com/guides/sse-vs-websockets
- [pn]: Railway docs, Private Networking. https://docs.railway.com/networking/private-networking
- [pn-how]: Railway docs, How Private Networking Works. https://docs.railway.com/networking/private-networking/how-it-works
- [cac]: Railway docs, Using Config as Code (deprecation banner). https://docs.railway.com/config-as-code
- [cac-ref]: Railway docs, Config as Code reference (builder values). https://docs.railway.com/config-as-code/reference
- [iac]: Railway docs, Infrastructure as Code. https://docs.railway.com/infrastructure-as-code
- [iac-ref]: Railway docs, Infrastructure as Code reference. https://docs.railway.com/infrastructure-as-code/reference
- [schema]: Railway config JSON schema. https://railway.com/railway.schema.json
- [railpack-default]: Railway changelog, 2025-09-19, "Railpack Default". https://railway.com/changelog/2025-09-19-railpack-default
- [build-config]: Railway docs, Build configuration (Railpack packages). https://docs.railway.com/builds/build-configuration
- [railpack-env]: Railpack docs, Environment variables. https://railpack.com/config/environment-variables
- [railpack-changelog]: Railpack changelog (v0.37.0, Debian 13). https://railpack.com/changelog
- [debian-gdal]: Debian packages, gdal-bin in trixie. https://packages.debian.org/trixie/gdal-bin
- [nixpacks-home]: Nixpacks docs home (maintenance-mode notice). https://nixpacks.com/docs
- [nixpacks-file]: Nixpacks docs, Configuration file. https://nixpacks.com/docs/configuration/file
- [nixpacks-nix]: Nixpacks source, default `NIXPKGS_ARCHIVE`. https://github.com/railwayapp/nixpacks/blob/144b4f9ab1c3943af4dfe76d3c79d91263f5b465/src/nixpacks/nix/mod.rs
- [nixpacks-node]: Nixpacks source, Node provider archive map and version resolution. https://github.com/railwayapp/nixpacks/blob/144b4f9ab1c3943af4dfe76d3c79d91263f5b465/src/providers/node/mod.rs
- [nixpkgs-gdal-2023]: nixpkgs `5148520b`, gdal 3.7.1. https://github.com/NixOS/nixpkgs/blob/5148520bfab61f99fd25fb9ff7bfbb50dad3c9db/pkgs/development/libraries/gdal/default.nix
- [nixpkgs-gdal-2025a]: nixpkgs `ffeebf0a`, gdal 3.10.1. https://github.com/NixOS/nixpkgs/blob/ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7/pkgs/development/libraries/gdal/default.nix
- [nixpkgs-gdal-2025b]: nixpkgs `e6f23dc0`, gdal 3.11.0. https://github.com/NixOS/nixpkgs/blob/e6f23dc08d3624daab7094b701aa3954923c6bbb/pkgs/by-name/gd/gdal/package.nix
- [nixpkgs-gdal-2025c]: nixpkgs `23f9169c`, gdal 3.11.4. https://github.com/NixOS/nixpkgs/blob/23f9169c4ccce521379e602cc82ed873a1f1b52b/pkgs/by-name/gd/gdal/package.nix
- [hydra-gdal]: Hydra build 351776197, gdal-3.13.3 (closure 1138.31 MiB). https://hydra.nixos.org/build/351776197
- [hydra-gdalmin]: Hydra build 351752806, gdal-minimal-3.13.3 (closure 604.14 MiB). https://hydra.nixos.org/build/351752806
- [hydra-gdal-sizes]: Hydra closure-size history, gdal. https://hydra.nixos.org/job/nixpkgs/trunk/gdal.x86_64-linux/closure-sizes
- [hydra-gdalmin-sizes]: Hydra closure-size history, gdalMinimal. https://hydra.nixos.org/job/nixpkgs/trunk/gdalMinimal.x86_64-linux/closure-sizes
- [gdal-cog]: GDAL docs, COG driver. https://gdal.org/en/stable/drivers/raster/cog.html
- [node-http]: Node.js v22 docs, `server.requestTimeout`. https://nodejs.org/docs/latest-v22.x/api/http.html#serverrequesttimeout
- [node-http-create]: Node.js v22 docs, `http.createServer` options (`connectionsCheckingInterval`). https://nodejs.org/docs/latest-v22.x/api/http.html#httpcreateserveroptions-requestlistener
- [node-ws]: Node.js v22 docs, `WebSocket` global. https://nodejs.org/docs/latest-v22.x/api/globals.html#websocket
- [node-net]: Node.js v22 docs, `server.listen()` default host. https://nodejs.org/docs/latest-v22.x/api/net.html#serverlistenport-host-backlog-callback
- [buckets]: Railway docs, Storage Buckets. https://docs.railway.com/storage-buckets
- [buckets-up]: Railway docs, Uploading & serving (presigned URLs). https://docs.railway.com/storage-buckets/uploading-serving
- [buckets-billing]: Railway docs, Storage Buckets billing (plan limits). https://docs.railway.com/storage-buckets/billing
