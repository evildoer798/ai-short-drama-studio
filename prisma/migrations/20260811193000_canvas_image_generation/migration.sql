CREATE TABLE "CanvasImageTask" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "mediaId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "provider" TEXT NOT NULL DEFAULT 'openai-compatible-image',
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "referenceNodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CanvasImageTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanvasImageTask_mediaId_key" ON "CanvasImageTask"("mediaId");
CREATE INDEX "CanvasImageTask_canvasId_status_idx" ON "CanvasImageTask"("canvasId", "status");
CREATE INDEX "CanvasImageTask_nodeId_createdAt_idx" ON "CanvasImageTask"("nodeId", "createdAt");
CREATE INDEX "CanvasImageTask_createdById_idx" ON "CanvasImageTask"("createdById");

ALTER TABLE "CanvasImageTask" ADD CONSTRAINT "CanvasImageTask_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "CreativeCanvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasImageTask" ADD CONSTRAINT "CanvasImageTask_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "CanvasNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasImageTask" ADD CONSTRAINT "CanvasImageTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CanvasImageTask" ADD CONSTRAINT "CanvasImageTask_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
