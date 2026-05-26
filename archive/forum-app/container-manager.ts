/**
 * container-manager.ts  —  Hardening #2: Process Containerization
 *
 * Instead of spawning Community Solid Server as a raw child_process, each pod
 * runs in its own Docker/Podman container with:
 *   - Hard memory + CPU cgroup limits
 *   - A dedicated bridge network (no host network access)
 *   - A named volume for pod storage (mapped from the host)
 *   - Read-only root filesystem except the volume mount
 *
 * The manager tracks running containers by sessionId, allows graceful teardown,
 * and exposes the container's CSS port via a deterministic host port assignment.
 */

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'

const exec = promisify(execFile)

// Detect docker vs podman at startup (prefer podman for rootless)
const RUNTIME = detectRuntime()

function detectRuntime(): string {
  try {
    execFileSync('podman', ['--version'], { stdio: 'ignore' })
    return 'podman'
  } catch {
    return 'docker'
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContainerConfig {
  sessionId:    string
  hostDataRoot: string   // host path for pod volume, e.g. /var/poddata
  hostPortBase: number   // pods get hostPortBase + index, e.g. 4000
  cssImage:     string   // e.g. "solidproject/community-server:latest"
  memoryLimit:  string   // e.g. "512m"
  cpuLimit:     string   // e.g. "0.5"  (fraction of one core)
  networkName:  string   // pre-created bridge network, e.g. "pod-network"
}

export interface ContainerHandle {
  sessionId:    string
  containerId:  string
  containerName:string
  hostPort:     number
  podUrl:       string
  volumeName:   string
}

// ─── Network setup (run once at app start) ────────────────────────────────────

export async function ensureNetwork(networkName: string): Promise<void> {
  try {
    await exec(RUNTIME, ['network', 'inspect', networkName])
    console.log(`[container-manager] Network "${networkName}" already exists.`)
  } catch {
    // Network doesn't exist yet
    await exec(RUNTIME, [
      'network', 'create',
      '--driver', 'bridge',
      '--opt', 'com.docker.network.bridge.enable_icc=false', // containers can't reach each other
      '--internal',  // no external routing from the container network
      networkName,
    ])
    console.log(`[container-manager] Created isolated bridge network "${networkName}".`)
  }
}

// ─── Launch a pod container ───────────────────────────────────────────────────

const portRegistry = new Map<number, string>() // port → sessionId

export async function launchPodContainer(cfg: ContainerConfig): Promise<ContainerHandle> {
  const hostPort    = allocatePort(cfg.hostPortBase, cfg.sessionId)
  const containerName = `pod-${cfg.sessionId.slice(0, 12)}`
  const volumeName    = `pod-vol-${cfg.sessionId.slice(0, 12)}`
  const hostVolumePath = `${cfg.hostDataRoot}/${cfg.sessionId}`

  // ── Create named volume (or reuse if the pod is being resumed) ───────────
  await exec(RUNTIME, [
    'volume', 'create',
    '--driver', 'local',
    '--opt', 'type=none',
    '--opt', `device=${hostVolumePath}`,
    '--opt', 'o=bind',
    volumeName,
  ]).catch(() => {
    // Volume may already exist on pod resume — that's fine
    console.log(`[container-manager] Volume ${volumeName} already exists; reusing.`)
  })

  // ── Run the CSS container ─────────────────────────────────────────────────
  const { stdout } = await exec(RUNTIME, [
    'run',
    '--detach',
    '--name',         containerName,
    '--network',      cfg.networkName,
    '--memory',       cfg.memoryLimit,
    '--memory-swap',  cfg.memoryLimit,   // disable swap for the container
    '--cpus',         cfg.cpuLimit,
    '--publish',      `127.0.0.1:${hostPort}:3000`,  // bind to loopback only
    '--volume',       `${volumeName}:/data:rw`,
    '--read-only',                         // root FS read-only
    '--tmpfs',        '/tmp:rw,size=64m',  // allow /tmp for CSS internals
    '--tmpfs',        '/var/run:rw,size=8m',
    '--security-opt', 'no-new-privileges=true',
    '--cap-drop',     'ALL',
    '--restart',      'unless-stopped',
    '--label',        `pod.sessionId=${cfg.sessionId}`,

    cfg.cssImage,

    // CSS args inside the container
    '--port',           '3000',
    '--config',         '@css:config/file.json',
    '--rootFilePath',   '/data',
  ])

  const containerId = stdout.trim()
  const podUrl      = `http://localhost:${hostPort}`

  console.log(`[container-manager] Started container ${containerName} (${containerId.slice(0,12)}) at ${podUrl}`)

  // Wait for CSS to be ready
  await waitForPodReady(podUrl)

  return { sessionId: cfg.sessionId, containerId, containerName, hostPort, podUrl, volumeName }
}

// ─── Stop & remove a pod container ───────────────────────────────────────────

export async function teardownPodContainer(handle: ContainerHandle): Promise<void> {
  try {
    await exec(RUNTIME, ['stop', '--time', '10', handle.containerName])
    await exec(RUNTIME, ['rm',   handle.containerName])
    portRegistry.delete(handle.hostPort)
    console.log(`[container-manager] Removed container ${handle.containerName}`)
  } catch (err) {
    console.error(`[container-manager] Teardown error for ${handle.containerName}:`, err)
  }
}

// ─── List running pod containers ─────────────────────────────────────────────

export async function listPodContainers(): Promise<Array<{ id: string; name: string; sessionId: string }>> {
  const { stdout } = await exec(RUNTIME, [
    'ps',
    '--filter', 'label=pod.sessionId',
    '--format', '{{.ID}}|{{.Names}}|{{.Label "pod.sessionId"}}',
  ])

  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, name, sessionId] = line.split('|')
    return { id, name, sessionId }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function allocatePort(base: number, sessionId: string): number {
  // Deterministic but collision-checked port assignment
  const hash = crypto.createHash('sha256').update(sessionId).digest()
  let port = base + (hash.readUInt16BE(0) % 1000)

  // Collision avoidance
  while (portRegistry.has(port)) {
    port = (port - base + 1) % 1000 + base
  }

  portRegistry.set(port, sessionId)
  return port
}

async function waitForPodReady(podUrl: string, maxAttempts = 20, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${podUrl}/`)
      if (res.ok || res.status === 401) {
        // CSS returns 401 when auth is required — server is up
        return
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error(`[container-manager] Pod at ${podUrl} did not become ready after ${maxAttempts}s`)
}

// ─── Docker Compose spec (generated per-pod) ─────────────────────────────────

/**
 * Generates a docker-compose.yml for a single pod.
 * Useful for development or for orchestrators that prefer Compose over raw docker run.
 */
export function generateComposeYaml(cfg: ContainerConfig, hostPort: number): string {
  return `# Auto-generated Compose spec for pod ${cfg.sessionId.slice(0, 8)}
# DO NOT EDIT MANUALLY

version: "3.9"

networks:
  ${cfg.networkName}:
    external: true

volumes:
  pod-vol-${cfg.sessionId.slice(0, 12)}:
    driver: local
    driver_opts:
      type: none
      device: ${cfg.hostDataRoot}/${cfg.sessionId}
      o: bind

services:
  css-${cfg.sessionId.slice(0, 8)}:
    image: ${cfg.cssImage}
    container_name: pod-${cfg.sessionId.slice(0, 12)}
    networks:
      - ${cfg.networkName}
    ports:
      - "127.0.0.1:${hostPort}:3000"
    volumes:
      - pod-vol-${cfg.sessionId.slice(0, 12)}:/data:rw
    tmpfs:
      - /tmp:rw,size=64m
      - /var/run:rw,size=8m
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: ${cfg.memoryLimit}
    memswap_limit: ${cfg.memoryLimit}
    cpus: ${cfg.cpuLimit}
    restart: unless-stopped
    labels:
      pod.sessionId: "${cfg.sessionId}"
    command:
      - "--port"
      - "3000"
      - "--config"
      - "@css:config/file.json"
      - "--rootFilePath"
      - "/data"
`
}
export async function getPortForSession(sessionId: string): Promise<number | null> {
  for (const [port, sess] of portRegistry.entries()) {
    if (sess === sessionId) return port;
  }
  return null;
}
