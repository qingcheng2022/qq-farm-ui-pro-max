SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `report_logs` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `account_id` VARCHAR(50) NOT NULL COMMENT '账号ID',
    `account_name` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '账号名称快照',
    `mode` VARCHAR(20) NOT NULL DEFAULT 'test' COMMENT '汇报类型: test/hourly/daily',
    `ok` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '发送是否成功',
    `channel` VARCHAR(50) NOT NULL DEFAULT '' COMMENT '推送渠道',
    `title` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '汇报标题',
    `content` MEDIUMTEXT COMMENT '汇报正文',
    `error_message` VARCHAR(500) NOT NULL DEFAULT '' COMMENT '失败原因',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
    INDEX `idx_report_logs_account_time` (`account_id`, `created_at`),
    INDEX `idx_report_logs_mode_time` (`mode`, `created_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = '经营汇报发送历史';
