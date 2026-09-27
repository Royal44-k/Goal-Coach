import { copyValidatedDatabase } from "./database-backup.mjs";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const task = args.length === 2
  ? copyValidatedDatabase(args[0], args[1])
  : Promise.reject(new Error("参数错误"));
task.then(() => console.info("数据库恢复到新文件完成；已校验完整性与外键。"))
  .catch(() => {
    console.error("恢复失败。请检查备份完整性、目标目录权限，并在应用停止时恢复到全新数据库路径。原有目标不会被覆盖。");
    process.exitCode = 1;
  });
