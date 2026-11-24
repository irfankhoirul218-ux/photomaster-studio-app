            (assetsPayload?.bgImageBlob?.size ?? 0) +
            (assetsPayload?.manualAlphaDelta?.byteLength ?? 0) +
            Math.max(4096, snap.thumbnailDataUrl.length);

          const summary: SavedProjectSummary = {
            id: snap.projectId,
            name: snap.projectName,
            createdAt: snap.createdAt,
            updatedAt: now,
            fileName: snap.imageMeta.name,
            width: snap.imageMeta.width,
            height: snap.imageMeta.height,
            fileSize: snap.imageMeta.fileSize,
            mimeType: snap.imageMeta.mimeType,
            thumbnailDataUrl: snap.thumbnailDataUrl,
            activePresetId: snap.editState.activePresetId,
            activePresetName: snap.activePresetName,
            maskCount: snap.maskLayers.length,
            retouchCount: snap.activeRetouchOps.length,
            hasTransparency: snap.hasTransparency,
            estimatedBytes,
          };

          const statePayload: SavedProjectStatePayload = {
            projectId: snap.projectId,
            editState: snap.editState,
            maskLayers: snap.maskLayers,
            activeMaskId: snap.activeMaskId,
            activeRetouchOps: snap.activeRetouchOps,
            archivedRetouchOps: snap.archivedRetouchOps,
            bgSettings: snap.bgSettings,
            bgRefinement: snap.bgRefinement,
            bgLastModelLabel: snap.bgLastModelLabel,
            hasTransparency: snap.hasTransparency,
            historyEntries: snap.historyEntries,
            historyCursor: snap.historyCursor,
            updatedAt: now,
          };

          await saveProjectToIdb(summary, statePayload, assetsPayload);

          if (activeProjectIdRef.current === snap.projectId) {
            if (snap.needAssets) {
              savedAssetRevisionRef.current = Math.max(
                savedAssetRevisionRef.current,
                snap.assetVersion
              );
            }
            setAutoSaveStatus('saved');
            setLastSavedAt(now);
            setSaveError(null);
            setLastActiveProjectId(snap.projectId);
          }

          await refreshProjectDirectory();
        } catch (err) {
          const message = formatIndexedDbError(err);
          if (activeProjectIdRef.current === snap.projectId) {
            setAutoSaveStatus('error');
            setSaveError(message);
          }
          setProjectsError(message);
          void checkStorageQuota().then(setStorageQuota);
        }
      };

      const nextPromise = saveQueueRef.current.then(task, task);
      saveQueueRef.current = nextPromise.catch(() => {});
      return nextPromise;
    },
    [refreshProjectDirectory]
  );

  const flushPendingAutoSave = useCallback(async () => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const snap = captureCurrentProjectSnapshot();
    if (snap) {
      await persistCapturedSnapshot(snap);
    }
  }, [captureCurrentProjectSnapshot, persistCapturedSnapshot]);

  // Debounced auto-save when project edits change
  useEffect(() => {
    if (!activeProjectId || !sourceImage || !imageMeta) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    const isInitialAssetWrite = savedAssetRevisionRef.current !== assetRevisionRef.current;
    const delayMs = isInitialAssetWrite ? 180 : 750;

    setAutoSaveStatus('saving');
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      const snap = captureCurrentProjectSnapshot();
      if (snap) {
        void persistCapturedSnapshot(snap);
      }
    }, delayMs);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [
    activeProjectId,
    sourceImage,
    imageMeta,
    activeProjectName,
    draftState,
    maskLayers,
    activeMaskId,
    retouchRenderTick,
    bgSettings,
    bgRefinement,
    hasTransparency,
    history,
    captureCurrentProjectSnapshot,
    persistCapturedSnapshot,
  ]);

  // Flush pending auto-save when tab becomes hidden or browser page unloads
  useEffect(() => {
    const handleVisibilityOrHide = () => {
      if (document.visibilityState === 'hidden' || autoSaveTimerRef.current !== null) {
        if (autoSaveTimerRef.current !== null) {
          window.clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
          const snap = captureCurrentProjectSnapshot();
          if (snap) {
            void persistCapturedSnapshot(snap);
          }
        }
      }
    };
    window.addEventListener('pagehide', handleVisibilityOrHide);
    document.addEventListener('visibilitychange', handleVisibilityOrHide);
    return () => {
      window.removeEventListener('pagehide', handleVisibilityOrHide);
      document.removeEventListener('visibilitychange', handleVisibilityOrHide);
    };
  }, [captureCurrentProjectSnapshot, persistCapturedSnapshot]);

  // Unified history push helper
  const pushHistoryEntry = useCallback((entry: HistoryEntry) => {
    const maxHistory = getDevicePerformanceProfile().maxHistoryEntries;
    setHistory((prev) => {
      const sliced = prev.entries.slice(0, prev.cursor);
      const appended = [...sliced, entry];
      let nextArchived = prev.archivedRetouchOps;
