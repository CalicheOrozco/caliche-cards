import { GridFSBucket, type Db, type ObjectId } from "mongodb";

export const MEDIA_BUCKET_NAME = "media";

export function isProbablyUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function getMediaBucket(db: Db): GridFSBucket {
  return new GridFSBucket(db, { bucketName: MEDIA_BUCKET_NAME });
}

export type CloudMediaDoc = {
  userId: string;
  libraryId: string;
  name: string;
  fileId: ObjectId;
  sha256: string;
  size: number;
  contentType: string;
  uploadedAt: number;
};
