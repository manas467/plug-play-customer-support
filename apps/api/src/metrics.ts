export const metrics = {
  requests: 0,
  failedRequests: 0,
  mlRequests: 0,
  mlFailures: 0,
  mlLatencyMs: 0,
  handoffs: 0,
  sourceJobs: 0,
  sourceJobFailures: 0,
};

export function recordMlCall(startedAt: number, failed: boolean) {
  metrics.mlRequests += 1;
  metrics.mlLatencyMs += Date.now() - startedAt;
  if (failed) metrics.mlFailures += 1;
}

export async function trackedMlFetch(input: string, init: RequestInit) {
  const started=Date.now();let failed=true;
  try{const response=await fetch(input,init);if(!response.ok)throw new Error("ML service request failed");failed=false;return response;}
  finally{recordMlCall(started,failed);}
}
