/**
 * Peer-dep type augmentation and loading.
 *
 * The dsh-opencontext plugin's runtime contract is: when a host loads the
 * built `lib/index.js`, the `apply(ctx, config)` function receives a
 * Cordis `Context` and a schemastery-resolved config. We re-export the
 * module so consumers can `import type { ApplyFn, ResolvedConfig } from
 * "dsh-opencontext"` and stay decoupled from the DSH ctx surface.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
export function profileNodeModulesDir(env = process.env) {
    const home = resolve(env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
    const profile = env.DSH_PROFILE?.trim() || "web";
    // A caller-controlled profile name must stay inside <home>/profiles.
    if (profile.includes("/") || profile.includes("\\") || profile.includes("..") || profile.includes("\0"))
        throw Object.assign(new Error("invalid DSH_PROFILE"), { code: "INVALID_INPUT" });
    const profilesRoot = resolve(home, "profiles");
    const candidate = resolve(profilesRoot, profile);
    if (candidate !== profilesRoot && !candidate.startsWith(profilesRoot + sep))
        throw Object.assign(new Error("invalid DSH_PROFILE"), { code: "INVALID_INPUT" });
    return join(candidate, "node_modules");
}
function profileModulesAnchor(env = process.env) {
    return join(profileNodeModulesDir(env), "dsh-opencontext-resolver.cjs");
}
function resolvePeer(specifier) {
    try {
        return createRequire(import.meta.url).resolve(specifier);
    }
    catch {
        return createRequire(profileModulesAnchor()).resolve(specifier);
    }
}
export async function loadPeer(specifier) {
    const href = pathToFileURL(resolvePeer(specifier)).href;
    return (await import(href));
}
//# sourceMappingURL=peers.js.map