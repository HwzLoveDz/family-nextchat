import "server-only";
import { getPool } from "./db";
import { FamilyApiError } from "./errors";
import { USAGE_PRICEBOOK, USAGE_PRICE_VERSION } from "./model-pricing";
import type {
  UsageDashboardCounters,
  UsageDashboardData,
  UsageDashboardDays,
} from "../usage-dashboard-types";

const COUNTERS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "requests",
  "reportedRequests",
  "unknownRequests",
  "runningRequests",
] as const;
export function usageDashboardRange(
  days: UsageDashboardDays,
  now = new Date(),
) {
  const china = new Date(now.getTime() + 8 * 3600000);
  const today = Date.UTC(
    china.getUTCFullYear(),
    china.getUTCMonth(),
    china.getUTCDate(),
  );
  const start = today - ((days === "all" ? 90 : days) - 1) * 86400000;
  return {
    from:
      days === "all"
        ? "1970-01-01T00:00:00.000Z"
        : new Date(start - 8 * 3600000).toISOString(),
    to: new Date(today + 86400000 - 8 * 3600000).toISOString(),
    firstDate: new Date(start).toISOString().slice(0, 10),
    lastDate: new Date(today).toISOString().slice(0, 10),
  };
}

/**
 * Every billable ledger entry is retained, including retries and superseded generations.
 * Validate snapshot calendar dates arithmetically: casting an untrusted model suffix
 * to a date can abort the entire query instead of leaving just that event unpriced.
 */
const EVENTS = `
 rates AS (SELECT * FROM jsonb_to_recordset($7::jsonb) AS p(model text,category text,"inputPerMillion" numeric,"outputPerMillion" numeric,"perMinute" numeric)),
 raw_events AS (
   SELECT user_id,started_at AS occurred_at,model AS requested_model,actual_model,usage_source,input_tokens,output_tokens,state,
     CASE WHEN model LIKE 'gpt-image-%' THEN 'image' ELSE 'chat' END AS category,NULL::double precision AS audio_seconds
   FROM family_generation WHERE kind='text' AND started_at>=$1::timestamptz AND started_at<$2::timestamptz AND ($3::text IS NULL OR user_id=$3)
   UNION ALL
   SELECT user_id,started_at,requested_model,actual_model,usage_source,input_tokens,output_tokens,state,kind,audio_seconds
   FROM family_voice_usage WHERE started_at>=$1::timestamptz AND started_at<$2::timestamptz AND ($3::text IS NULL OR user_id=$3)
   UNION ALL
   SELECT user_id,created_at,requested_model,actual_model,usage_source,input_tokens,output_tokens,state,
     CASE WHEN kind='response' THEN 'realtime' ELSE 'transcribe' END,NULL::double precision
   FROM family_realtime_usage WHERE created_at>=$1::timestamptz AND created_at<$2::timestamptz AND ($3::text IS NULL OR user_id=$3)
 ), normalized_events AS (
   SELECT *,COALESCE(NULLIF(actual_model,''),NULLIF(requested_model,''),'未记录模型') AS model,
     CASE WHEN NULLIF(actual_model,'') IS NOT NULL THEN 'reported' ELSE 'requested' END AS model_source,
     CASE WHEN usage_source='reported' THEN COALESCE(input_tokens,0) ELSE 0 END AS known_input,
     CASE WHEN usage_source='reported' THEN COALESCE(output_tokens,0) ELSE 0 END AS known_output
   FROM raw_events
 ), price_models AS (
   SELECT n.*,regexp_match(n.model,'^(.*)-([0-9]{4})-([0-9]{2})-([0-9]{2})$') AS model_snapshot
   FROM normalized_events n
 ), events AS (
   SELECT n.*,CASE
     WHEN n.usage_source='reported' AND p."inputPerMillion" IS NOT NULL AND p."outputPerMillion" IS NOT NULL
       THEN (n.known_input*p."inputPerMillion"+n.known_output*p."outputPerMillion")/1000000
     WHEN p."perMinute" IS NOT NULL AND n.audio_seconds IS NOT NULL AND n.audio_seconds>=0 AND n.state='complete'
       THEN n.audio_seconds::numeric*p."perMinute"/60
     ELSE NULL END AS estimated_usd
   FROM price_models n LEFT JOIN rates p ON p.model=CASE
     WHEN n.model_snapshot IS NULL THEN n.model
     WHEN n.model_snapshot[3]::integer BETWEEN 1 AND 12
       AND n.model_snapshot[4]::integer BETWEEN 1 AND CASE
         WHEN n.model_snapshot[3]::integer=2 THEN 28+CASE
           WHEN n.model_snapshot[2]::integer%400=0 OR (n.model_snapshot[2]::integer%4=0 AND n.model_snapshot[2]::integer%100<>0) THEN 1 ELSE 0 END
         WHEN n.model_snapshot[3]::integer IN (4,6,9,11) THEN 30 ELSE 31 END
       THEN n.model_snapshot[1]
     ELSE NULL END AND p.category=n.category
 )`;
const counterJson = (alias: string) =>
  `'inputTokens',COALESCE(${alias}.input_tokens,0),'outputTokens',COALESCE(${alias}.output_tokens,0),'totalTokens',COALESCE(${alias}.input_tokens,0)+COALESCE(${alias}.output_tokens,0),'requests',COALESCE(${alias}.requests,0),'reportedRequests',COALESCE(${alias}.reported_requests,0),'unknownRequests',COALESCE(${alias}.unknown_requests,0),'runningRequests',COALESCE(${alias}.running_requests,0),'cost',jsonb_build_object('estimatedUSD',CASE WHEN COALESCE(${alias}.priced_requests,0)=0 AND COALESCE(${alias}.requests,0)>0 THEN NULL ELSE COALESCE(${alias}.estimated_usd,0) END,'pricedRequests',COALESCE(${alias}.priced_requests,0),'unpricedRequests',COALESCE(${alias}.unpriced_requests,0),'priceVersion',$8::text)`;
const aggregate = `SUM(known_input) AS input_tokens,SUM(known_output) AS output_tokens,COUNT(*) AS requests,COUNT(*) FILTER(WHERE usage_source='reported') AS reported_requests,COUNT(*) FILTER(WHERE usage_source<>'reported') AS unknown_requests,COUNT(*) FILTER(WHERE state='running') AS running_requests,SUM(estimated_usd) AS estimated_usd,COUNT(*) FILTER(WHERE estimated_usd IS NOT NULL) AS priced_requests,COUNT(*) FILTER(WHERE estimated_usd IS NULL) AS unpriced_requests`;
const aggregateAgain = `SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(requests) AS requests,SUM(reported_requests) AS reported_requests,SUM(unknown_requests) AS unknown_requests,SUM(running_requests) AS running_requests,SUM(estimated_usd) AS estimated_usd,SUM(priced_requests) AS priced_requests,SUM(unpriced_requests) AS unpriced_requests`;

export const USAGE_DASHBOARD_SQL = `WITH ${EVENTS},
 totals AS (SELECT ${aggregate} FROM events),
 per_day AS (SELECT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day,${aggregate} FROM events GROUP BY 1),
 per_model AS (SELECT model,model_source,${aggregate} FROM events GROUP BY model,model_source),
 ranked_models AS (SELECT *,row_number() OVER(ORDER BY input_tokens+output_tokens DESC,requests DESC,model,model_source) AS rank FROM per_model),
 model_buckets AS (SELECT CASE WHEN rank<=11 THEN model ELSE NULL END AS model,CASE WHEN rank<=11 THEN model_source ELSE 'mixed' END AS model_source,${aggregateAgain} FROM ranked_models GROUP BY 1,2),
 per_person AS (SELECT user_id,${aggregate} FROM events GROUP BY user_id),
 ranked_people AS (SELECT u.id,u.name,COALESCE(p.input_tokens,0) AS input_tokens,COALESCE(p.output_tokens,0) AS output_tokens,COALESCE(p.requests,0) AS requests,COALESCE(p.reported_requests,0) AS reported_requests,COALESCE(p.unknown_requests,0) AS unknown_requests,COALESCE(p.running_requests,0) AS running_requests,COALESCE(p.estimated_usd,0) AS estimated_usd,COALESCE(p.priced_requests,0) AS priced_requests,COALESCE(p.unpriced_requests,0) AS unpriced_requests,row_number() OVER(ORDER BY COALESCE(p.input_tokens,0)+COALESCE(p.output_tokens,0) DESC,COALESCE(p.requests,0) DESC,u.id) AS rank FROM "user" u LEFT JOIN per_person p ON p.user_id=u.id WHERE ($3::text IS NULL OR u.id=$3)),
 person_buckets AS (SELECT CASE WHEN rank<=199 THEN id ELSE NULL END AS id,CASE WHEN rank<=199 THEN name ELSE '其他成员' END AS name,${aggregateAgain} FROM ranked_people GROUP BY 1,2),
 member_list AS (SELECT id,name FROM "user" WHERE ($6::boolean OR id=$3) ORDER BY "createdAt",id LIMIT 200)
 SELECT jsonb_build_object(
 'userExists',($3::text IS NULL OR EXISTS(SELECT 1 FROM "user" WHERE id=$3)),
 'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) FROM member_list),'[]'::jsonb),
 'membersTruncated',(SELECT count(*)>200 FROM "user" WHERE ($6::boolean OR id=$3)),
 'summary',(SELECT jsonb_build_object(${counterJson("t")}) FROM totals t),
 'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('date',to_char(d.day,'YYYY-MM-DD'),${counterJson(
   "p",
 )}) ORDER BY d.day) FROM generate_series($4::date,$5::date,interval '1 day') AS d(day) LEFT JOIN per_day p ON p.day=d.day::date),'[]'::jsonb),
 'models',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',CASE WHEN m.model IS NULL THEN 'other' ELSE m.model_source||':'||m.model END,'model',m.model,'label',COALESCE(m.model,'其他模型'),'source',m.model_source,${counterJson(
   "m",
 )}) ORDER BY m.input_tokens+m.output_tokens DESC,m.requests DESC,m.model NULLS LAST,m.model_source) FROM model_buckets m),'[]'::jsonb),
 'people',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,${counterJson(
   "p",
 )}) ORDER BY p.input_tokens+p.output_tokens DESC,p.requests DESC,p.id NULLS LAST) FROM person_buckets p),'[]'::jsonb)
 ) AS payload`;

function validateCounters(
  value: unknown,
): asserts value is UsageDashboardCounters {
  if (
    !value ||
    typeof value !== "object" ||
    COUNTERS.some(
      (key) =>
        !Number.isSafeInteger((value as UsageDashboardCounters)[key]) ||
        (value as UsageDashboardCounters)[key] < 0,
    )
  )
    throw new FamilyApiError(
      503,
      "用量统计暂时无法显示，请稍后重试。",
      "USAGE_TOTAL_INVALID",
    );
  const v = value as UsageDashboardCounters;
  const cost = v.cost;
  if (
    !cost ||
    !Number.isSafeInteger(cost.pricedRequests) ||
    !Number.isSafeInteger(cost.unpricedRequests) ||
    cost.pricedRequests < 0 ||
    cost.unpricedRequests < 0 ||
    cost.pricedRequests + cost.unpricedRequests !== v.requests ||
    typeof cost.priceVersion !== "string" ||
    (cost.estimatedUSD !== null &&
      (typeof cost.estimatedUSD !== "number" ||
        !Number.isFinite(cost.estimatedUSD) ||
        cost.estimatedUSD < 0 ||
        cost.estimatedUSD > 1e12)) ||
    (cost.estimatedUSD === null &&
      (cost.pricedRequests > 0 || v.requests === 0)) ||
    (cost.estimatedUSD !== null && cost.pricedRequests === 0 && v.requests > 0)
  )
    throw new FamilyApiError(
      503,
      "用量统计暂时无法显示，请稍后重试。",
      "USAGE_TOTAL_INVALID",
    );
  if (
    v.totalTokens !== v.inputTokens + v.outputTokens ||
    v.reportedRequests + v.unknownRequests !== v.requests ||
    v.runningRequests > v.requests
  )
    throw new FamilyApiError(
      503,
      "用量统计暂时无法显示，请稍后重试。",
      "USAGE_TOTAL_INVALID",
    );
}

export async function loadUsageDashboard(
  days: UsageDashboardDays,
  access: { actorId: string; admin: boolean; userId?: string },
  now = new Date(),
): Promise<UsageDashboardData> {
  if (
    !access ||
    typeof access.actorId !== "string" ||
    !access.actorId ||
    access.actorId.length > 128 ||
    /[\x00-\x1f\x7f]/.test(access.actorId) ||
    typeof access.admin !== "boolean"
  )
    throw new FamilyApiError(
      403,
      "无法确认用量访问权限。",
      "USAGE_ACCESS_INVALID",
    );
  if (
    !access.admin &&
    access.userId !== undefined &&
    access.userId !== access.actorId
  )
    throw new FamilyApiError(403, "仅可查看自己的用量。", "USAGE_SELF_ONLY");
  const userId = access.admin ? access.userId : access.actorId;
  if (
    ![7, 30, 90, "all"].includes(days) ||
    (userId !== undefined &&
      (!userId || userId.length > 128 || /[\x00-\x1f\x7f]/.test(userId)))
  )
    throw new FamilyApiError(400, "用量筛选无效。", "INVALID_USAGE_FILTER");
  const range = usageDashboardRange(days, now);
  const row = (
    await getPool().query(USAGE_DASHBOARD_SQL, [
      range.from,
      range.to,
      userId ?? null,
      range.firstDate,
      range.lastDate,
      access.admin,
      JSON.stringify(USAGE_PRICEBOOK),
      USAGE_PRICE_VERSION,
    ])
  ).rows[0]?.payload;
  if (!row || !row.userExists)
    throw new FamilyApiError(
      row ? 404 : 503,
      row ? "成员不存在。" : "用量统计暂时不可用。",
      row ? "USAGE_MEMBER_NOT_FOUND" : "USAGE_UNAVAILABLE",
    );
  if (
    !Array.isArray(row.members) ||
    row.members.length > 200 ||
    !Array.isArray(row.daily) ||
    row.daily.length !== (days === "all" ? 90 : days) ||
    !Array.isArray(row.models) ||
    row.models.length > 12 ||
    !Array.isArray(row.people) ||
    row.people.length > 200
  )
    throw new FamilyApiError(503, "用量统计暂时不可用。", "USAGE_UNAVAILABLE");
  validateCounters(row.summary);
  for (const group of [...row.daily, ...row.models, ...row.people])
    validateCounters(group);
  if (
    !access.admin &&
    (row.members.some(
      (member: { id: string }) => member.id !== access.actorId,
    ) ||
      row.people.some(
        (person: { id: string | null }) => person.id !== access.actorId,
      ))
  )
    throw new FamilyApiError(
      503,
      "用量统计暂时不可用。",
      "USAGE_SCOPE_INVALID",
    );
  for (const groups of [
    row.models,
    row.people,
    ...(days === "all" ? [] : [row.daily]),
  ] as UsageDashboardCounters[][]) {
    if (
      COUNTERS.some(
        (key) =>
          groups.reduce((sum, group) => sum + group[key], 0) !==
          row.summary[key],
      )
    )
      throw new FamilyApiError(
        503,
        "用量统计暂时不可用。",
        "USAGE_TOTAL_INVALID",
      );
    const priced = groups.reduce(
        (sum, group) => sum + (group.cost?.pricedRequests ?? 0),
        0,
      ),
      unpriced = groups.reduce(
        (sum, group) => sum + (group.cost?.unpricedRequests ?? 0),
        0,
      ),
      amount = groups.reduce(
        (sum, group) => sum + (group.cost?.estimatedUSD ?? 0),
        0,
      );
    if (
      priced !== row.summary.cost.pricedRequests ||
      unpriced !== row.summary.cost.unpricedRequests ||
      Math.abs(amount - (row.summary.cost.estimatedUSD ?? 0)) >
        Math.max(1e-9, Math.abs(amount) * 1e-10)
    )
      throw new FamilyApiError(
        503,
        "用量统计暂时不可用。",
        "USAGE_TOTAL_INVALID",
      );
  }
  if (
    days === "all" &&
    COUNTERS.some(
      (key) =>
        row.daily.reduce(
          (sum: number, group: UsageDashboardCounters) => sum + group[key],
          0,
        ) > row.summary[key],
    )
  )
    throw new FamilyApiError(
      503,
      "用量统计暂时不可用。",
      "USAGE_TOTAL_INVALID",
    );
  // Explicit field mapping keeps database diagnostics and ledger contents private.
  const counters = (value: UsageDashboardCounters): UsageDashboardCounters =>
    ({
      ...Object.fromEntries(COUNTERS.map((key) => [key, value[key]])),
      cost: value.cost
        ? {
            estimatedUSD: value.cost.estimatedUSD,
            pricedRequests: value.cost.pricedRequests,
            unpricedRequests: value.cost.unpricedRequests,
            priceVersion: value.cost.priceVersion,
          }
        : undefined,
    }) as unknown as UsageDashboardCounters;
  return {
    days,
    trendDays: days === "all" ? 90 : days,
    scope: access.admin ? "admin" : "self",
    timezone: "Asia/Shanghai",
    from: range.from,
    to: range.to,
    updatedAt: now.toISOString(),
    selectedUserId: userId ?? null,
    members: row.members.map((member: { id: string; name: string }) => ({
      id: member.id,
      name: member.name,
    })),
    membersTruncated: row.membersTruncated === true,
    summary: counters(row.summary),
    daily: row.daily.map(
      (value: UsageDashboardCounters & { date: string }) => ({
        date: value.date,
        ...counters(value),
      }),
    ),
    models: row.models.map(
      (
        value: UsageDashboardCounters & {
          id: string;
          model: string | null;
          label: string;
          source: "reported" | "requested" | "mixed";
        },
      ) => ({
        id: value.id,
        model: value.model,
        label: value.label,
        source: value.source,
        ...counters(value),
      }),
    ),
    people: row.people.map(
      (
        value: UsageDashboardCounters & { id: string | null; name: string },
      ) => ({ id: value.id, name: value.name, ...counters(value) }),
    ),
  };
}
