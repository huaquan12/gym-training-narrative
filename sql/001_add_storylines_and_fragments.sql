-- ============================================================
-- Migration 001: Add training_storylines, fragments, media_assets
-- For: gym-training-narrative MVP1
-- Date: 2026-07-03
-- 
-- Adds to existing schema (members, coaches, training_sessions,
-- training_plans, decision_points already exist on project 575772)
-- ============================================================

-- -----------------------------------------------------------
-- 1. training_storylines — 训练主线（跨 session 目标串联）
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_storylines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    coach_id        UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,

    -- 主线定义
    title           TEXT NOT NULL,               -- "引体向上从0到1"
    storyline_type  TEXT NOT NULL DEFAULT 'strength_progression'
                    CHECK (storyline_type IN (
                        'skill_acquisition',      -- 技能习得（如第一个引体）
                        'strength_progression',   -- 力量进阶（如深蹲破百）
                        'rehabilitation',         -- 康复训练
                        'body_composition',       -- 体态改善
                        'endurance',              -- 耐力提升
                        'custom'                  -- 自定义
                    )),

    -- 目标
    target_description       TEXT NOT NULL,       -- "完成第一个标准引体向上"
    measurable_criteria      TEXT,                -- "全程控制、正手握、下巴过杠"
    target_date              DATE,                -- 可选的目标日期
    baseline_description     TEXT,                -- "当前：辅助引体 -30kg 可完成 8 个"

    -- 关联的核心动作（JSON 数组）
    key_exercises   TEXT[] DEFAULT '{}',          -- ['引体向上', '高位下拉', '离心引体']

    -- 训练频率预期
    expected_sessions_per_week  SMALLINT DEFAULT 2,

    -- 里程碑（JSONB 数组）
    -- [{ "order": 1, "description": "辅助引体-20kg×8", "status": "achieved|in_progress|not_started",
    --    "achieved_at": "2026-07-15", "session_id": "uuid" }]
    milestones      JSONB DEFAULT '[]'::jsonb,

    -- Agent 自动追踪的进展数据点
    -- [{ "session_id": "uuid", "date": "2026-07-01", "exercise": "辅助引体",
    --    "metric_name": "assistance_weight_kg", "metric_value": 30 }]
    progress_data_points  JSONB DEFAULT '[]'::jsonb,

    -- Agent 计算的趋势
    trend           TEXT DEFAULT 'unknown'
                    CHECK (trend IN ('improving', 'plateau', 'regressing', 'unknown')),
    projected_target_date  DATE,                 -- Agent 预测的达标日期

    -- 状态
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'achieved', 'paused', 'abandoned')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE training_storylines IS '训练主线：跨多次训练的目标串联、里程碑追踪、进展数据';

CREATE INDEX idx_storylines_member ON training_storylines (member_id);
CREATE INDEX idx_storylines_coach  ON training_storylines (coach_id);
CREATE INDEX idx_storylines_status ON training_storylines (status);

-- -----------------------------------------------------------
-- 2. media_assets — 媒体资产（视频/图片/录音文件索引）
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID REFERENCES training_sessions(id) ON DELETE SET NULL,
    storyline_id    UUID REFERENCES training_storylines(id) ON DELETE SET NULL,

    -- 媒体类型
    media_type      TEXT NOT NULL
                    CHECK (media_type IN ('video', 'image', 'audio', 'whiteboard')),

    -- 存储信息（阿里云 OSS）
    oss_bucket      TEXT NOT NULL DEFAULT 'pubhtml-files',
    oss_key         TEXT NOT NULL,                -- OSS 对象路径
    oss_url         TEXT,                          -- 完整访问 URL
    thumbnail_key   TEXT,                          -- 缩略图 OSS 路径
    thumbnail_url   TEXT,                          -- 缩略图 URL

    -- 关联信息
    exercise_order  SMALLINT,                      -- 关联到 session 中的第几个动作
    exercise_name   TEXT,                          -- 冗余存储动作名
    caption         TEXT,                          -- 描述/标题

    -- 媒体元数据
    file_size_bytes BIGINT,
    duration_sec    NUMERIC(6,1),                  -- 视频/录音时长
    mime_type       TEXT,
    width           SMALLINT,                      -- 图片/视频宽度
    height          SMALLINT,                      -- 图片/视频高度

    -- OCR/转录结果
    ocr_text        TEXT,                          -- 板书 OCR 结果
    transcript      TEXT,                          -- 录音转录结果
    extracted_data  JSONB DEFAULT '{}'::jsonb,     -- 从 OCR/转录中提取的结构化数据

    -- 处理状态
    processing_status TEXT NOT NULL DEFAULT 'uploaded'
                    CHECK (processing_status IN (
                        'uploaded',       -- 已上传，待处理
                        'processing',     -- 处理中
                        'completed',      -- 处理完成
                        'failed'          -- 处理失败
                    )),

    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ
);

COMMENT ON TABLE media_assets IS '媒体资产索引：视频/图片/录音/板书的存储位置和处理状态';

CREATE INDEX idx_media_session    ON media_assets (session_id);
CREATE INDEX idx_media_storyline  ON media_assets (storyline_id);
CREATE INDEX idx_media_type       ON media_assets (media_type);
CREATE INDEX idx_media_processing ON media_assets (processing_status) WHERE processing_status != 'completed';

-- -----------------------------------------------------------
-- 3. session_fragments — 训练碎片（课中采集的原始碎片）
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_fragments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,

    -- 碎片类型
    fragment_type   TEXT NOT NULL
                    CHECK (fragment_type IN (
                        'whiteboard_photo',   -- 板书照片
                        'exercise_video',     -- 动作视频
                        'voice_memo',         -- 语音备忘
                        'text_note',          -- 文字笔记
                        'photo'               -- 普通照片
                    )),

    -- 原始内容
    raw_text        TEXT,                      -- 文字内容或转录结果
    media_asset_id  UUID REFERENCES media_assets(id) ON DELETE SET NULL,  -- 关联的媒体文件

    -- Agent 提取的结构化数据
    -- { "exercises": [...], "decision_points": [...], "set_logs": [...] }
    extracted_data  JSONB DEFAULT '{}'::jsonb,
    extraction_confidence NUMERIC(3,2) DEFAULT 0.0,

    -- 自动标签
    auto_tags       TEXT[] DEFAULT '{}',        -- Agent 自动打的标签

    -- 碎片状态
    status          TEXT NOT NULL DEFAULT 'raw'
                    CHECK (status IN (
                        'raw',            -- 原始未处理
                        'processed',      -- 已提取结构化数据
                        'merged',         -- 已合并到 session 记录
                        'discarded'       -- 被丢弃（无用信息）
                    )),

    captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ
);

COMMENT ON TABLE session_fragments IS '训练碎片：课中采集的原始信号，Agent 课后统一拼凑';

CREATE INDEX idx_fragments_session ON session_fragments (session_id);
CREATE INDEX idx_fragments_status  ON session_fragments (status);
CREATE INDEX idx_fragments_type    ON session_fragments (fragment_type);

-- -----------------------------------------------------------
-- 4. storyline_sessions — 主线与课程的关联（多对多）
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS storyline_sessions (
    storyline_id    UUID NOT NULL REFERENCES training_storylines(id) ON DELETE CASCADE,
    session_id      UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
    
    -- 本次课程在此主线中的关键数据
    -- { "exercises_done": ["引体向上", "高位下拉"], 
    --   "key_metrics": { "max_reps": 5, "assistance_kg": 20 },
    --   "coach_notes": "控制力提升" }
    session_data    JSONB DEFAULT '{}'::jsonb,
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    PRIMARY KEY (storyline_id, session_id)
);

COMMENT ON TABLE storyline_sessions IS '训练主线与课程的关联：记录每次课对主线目标的贡献';

CREATE INDEX idx_ss_session ON storyline_sessions (session_id);

-- -----------------------------------------------------------
-- 5. updated_at 触发器（复用已有函数）
-- -----------------------------------------------------------
CREATE TRIGGER trg_storylines_updated_at
    BEFORE UPDATE ON training_storylines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- -----------------------------------------------------------
-- 6. 视图：主线进展时间线
-- -----------------------------------------------------------
CREATE OR REPLACE VIEW v_storyline_timeline AS
SELECT
    sl.id AS storyline_id,
    sl.title AS storyline_title,
    sl.storyline_type,
    sl.status AS storyline_status,
    sl.target_description,
    sl.trend,
    sl.projected_target_date,
    m.id AS member_id,
    m.name AS member_name,
    c.id AS coach_id,
    c.name AS coach_name,
    sl.milestones,
    sl.progress_data_points,
    sl.key_exercises,
    -- 关联的课程数
    (SELECT count(*) FROM storyline_sessions ss WHERE ss.storyline_id = sl.id) AS session_count,
    -- 关联的媒体数
    (SELECT count(*) FROM media_assets ma WHERE ma.storyline_id = sl.id) AS media_count,
    -- 最近一次课程日期
    (SELECT max(ts.scheduled_at) 
     FROM storyline_sessions ss 
     JOIN training_sessions ts ON ts.id = ss.session_id 
     WHERE ss.storyline_id = sl.id) AS last_session_date,
    sl.created_at,
    sl.updated_at
FROM training_storylines sl
JOIN members m ON m.id = sl.member_id
JOIN coaches c ON c.id = sl.coach_id
ORDER BY sl.updated_at DESC;

COMMENT ON VIEW v_storyline_timeline IS '训练主线时间线：汇总主线进展、课程数、媒体数';

-- -----------------------------------------------------------
-- 7. 给 training_sessions 添加碎片相关字段（如果还没有）
-- -----------------------------------------------------------
DO $$
BEGIN
    -- 添加 fragment_assembly_status 字段
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'training_sessions' AND column_name = 'fragment_assembly_status'
    ) THEN
        ALTER TABLE training_sessions 
        ADD COLUMN fragment_assembly_status TEXT DEFAULT 'none'
        CHECK (fragment_assembly_status IN ('none', 'pending', 'assembled', 'confirmed'));
    END IF;
    
    -- 添加 fragment_count 字段
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'training_sessions' AND column_name = 'fragment_count'
    ) THEN
        ALTER TABLE training_sessions 
        ADD COLUMN fragment_count SMALLINT DEFAULT 0;
    END IF;
END $$;

-- -----------------------------------------------------------
-- END OF MIGRATION 001
-- -----------------------------------------------------------
