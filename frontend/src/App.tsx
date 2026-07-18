import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { NetworkMap } from './components/NetworkMap.js';
import { DeviationTimeline } from './components/DeviationTimeline.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { RawMtrPanel } from './components/RawMtrPanel.js';
import { ThemeSwitcher } from './components/ThemeSwitcher.js';
import { api } from './api/client.js';
import { useSSE } from './hooks/useSSE.js';
import { useTheme } from './hooks/useTheme.js';
import type { Target, MapResult, Deviation, RunHistoryEntry } from './types.js';

export function App() {
  const [theme, setTheme] = useTheme();
  const [targets, setTargets] = useState<Target[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mapData, setMapData] = useState<MapResult | null>(null);
  const [deviations, setDeviations] = useState<Deviation[]>([]);
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [historyActive, setHistoryActive] = useState<{ ttl: number; host: string }[] | null>(
    null,
  );

  const refreshTargets = useCallback(() => {
    api.listTargets().then((list) => {
      setTargets(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    });
  }, []);

  const refreshMap = useCallback((targetId: number) => {
    api.getMap(targetId).then(setMapData);
    api.getDeviations(targetId).then(setDeviations);
    api.getRunHistory(targetId, 1).then(setRunHistory);
    setHistoryActive(null);
  }, []);

  useEffect(() => {
    refreshTargets();
  }, [refreshTargets]);

  useEffect(() => {
    if (selectedId !== null) refreshMap(selectedId);
  }, [selectedId, refreshMap]);

  useSSE(
    selectedId,
    useCallback(() => {
      if (selectedId !== null) refreshMap(selectedId);
    }, [selectedId, refreshMap]),
  );

  const selectedTarget = targets.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">MTR Dashboard</span>
        <span className="brand-sub">
          {selectedTarget ? `probing ${selectedTarget.host}` : 'no target selected'}
        </span>
        <ThemeSwitcher theme={theme} onSelect={setTheme} />
      </header>
      <Sidebar
        targets={targets}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={(values) => {
          api.createTarget(values).then(refreshTargets);
        }}
        onDelete={(id) => {
          api.deleteTarget(id).then(refreshTargets);
        }}
      />
      <main>
        {selectedTarget && mapData && (
          <>
            <ConfigPanel
              target={selectedTarget}
              onSave={(values) => {
                api.updateTarget(selectedTarget.id, values).then(refreshTargets);
              }}
            />
            {historyActive !== null && (
              <div className="history-banner">
                <span>Viewing historical path</span>
                <button onClick={() => setHistoryActive(null)}>Back to live</button>
              </div>
            )}
            <NetworkMap
              targetId={selectedTarget.id}
              mapData={mapData}
              historyActive={historyActive}
            />
            <div className="bottom-panels">
              <RawMtrPanel run={runHistory[0] ?? null} />
              <DeviationTimeline
                deviations={deviations}
                onScrub={(at) => {
                  api
                    .getHistory(selectedTarget.id, at)
                    .then((result) => setHistoryActive(result.active));
                }}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
