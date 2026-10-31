export const TEST_HOST_PERMISSIONS: string[];
export interface ExtensionManifest {
  manifest_version: number;
  name: string;
  version: string;
  version_name?: string;
  description?: string;
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: unknown;
  [key: string]: unknown;
}
export function transformManifest(manifest: ExtensionManifest, options?: { testHosts?: boolean }): ExtensionManifest;
export function buildExtension(options?: { outDir?: string; testHosts?: boolean }): Promise<{ outDir: string; testHosts: boolean; sizes: Record<string, number> }>;
