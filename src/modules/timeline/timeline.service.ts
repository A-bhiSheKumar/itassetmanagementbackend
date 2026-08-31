import { AssetEventModel, type AssetEvent } from './assetEvent.model.js';

export interface TimelineEntry extends AssetEvent {
  _id: unknown;
}

/** The timeline for one asset, newest first. */
export async function assetTimeline(
  assetId: string,
  options: { limit?: number } = {},
): Promise<TimelineEntry[]> {
  return AssetEventModel.find({ assetId })
    .sort({ occurredAt: -1, _id: -1 })
    .limit(options.limit ?? 50)
    .lean<TimelineEntry[]>();
}

/** The tenant-wide activity feed on the dashboard. */
export async function recentActivity(limit = 20): Promise<TimelineEntry[]> {
  return AssetEventModel.find({})
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit)
    .lean<TimelineEntry[]>();
}
