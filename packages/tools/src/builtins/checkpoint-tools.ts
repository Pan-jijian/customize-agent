// @customize-agent/tools — 检查点工具
import { WorkspaceSnapshotService } from '../core/workspace-snapshot.js';

export class CheckpointTools {
  private snapshots: WorkspaceSnapshotService;

  constructor(cwd: string) {
    this.snapshots = new WorkspaceSnapshotService(cwd);
  }

  async checkpointCreate(name: string): Promise<string> {
    const manifest = await this.snapshots.createCheckpoint(name);
    return `Checkpoint created: ${name} (${manifest.files.length} files, ${manifest.skipped.length} skipped)`;
  }

  async checkpointList(): Promise<string> {
    const names = await this.snapshots.listCheckpoints();
    return names.join('\n') || 'No checkpoints.';
  }

  async checkpointRestore(name: string): Promise<string> {
    const result = await this.snapshots.restoreCheckpoint(name);
    return `Checkpoint restored: ${name} (${result.files} files)`;
  }

  async checkpointDelete(name: string): Promise<string> {
    await this.snapshots.deleteCheckpoint(name);
    return `Checkpoint deleted: ${name}`;
  }
}
