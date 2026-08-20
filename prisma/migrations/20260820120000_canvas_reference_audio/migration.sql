ALTER TYPE "MediaKind" ADD VALUE IF NOT EXISTS 'audio';
ALTER TYPE "CanvasNodeType" ADD VALUE IF NOT EXISTS 'audio';

CREATE TABLE "CanvasAudioTask" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "mediaId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL DEFAULT 'cangyuan-audio',
    "model" TEXT NOT NULL DEFAULT 'gemini-music',
    "prompt" TEXT NOT NULL,
    "providerJobId" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "CanvasAudioTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanvasAudioTask_mediaId_key" ON "CanvasAudioTask"("mediaId");
CREATE INDEX "CanvasAudioTask_canvasId_status_idx" ON "CanvasAudioTask"("canvasId", "status");
CREATE INDEX "CanvasAudioTask_nodeId_createdAt_idx" ON "CanvasAudioTask"("nodeId", "createdAt");
CREATE INDEX "CanvasAudioTask_createdById_idx" ON "CanvasAudioTask"("createdById");

ALTER TABLE "CanvasAudioTask" ADD CONSTRAINT "CanvasAudioTask_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "CreativeCanvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasAudioTask" ADD CONSTRAINT "CanvasAudioTask_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "CanvasNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasAudioTask" ADD CONSTRAINT "CanvasAudioTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasAudioTask" ADD CONSTRAINT "CanvasAudioTask_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
