import { Colors, ensureDir, ensureFile, existsSync } from "../deps.ts";
import {
  DEFAULT_DATAFILES_PATH,
  DEFAULT_DIM_FILE_PATH,
  DEFAULT_DIM_LOCK_FILE_PATH,
  DIM_FILE_VERSION,
  DIM_LOCK_FILE_VERSION,
} from "./consts.ts";
import { Downloader } from "./downloader.ts";
import { ConsoleAnimation } from "./console_animation.ts";
import { DimFileAccessor, DimLockFileAccessor } from "./accessor.ts";
import { Content, DimJSON, DimLockJSON, LockContent } from "./types.ts";
import { Encoder } from "./postprocess/encoder.ts";
import { Unzipper } from "./postprocess/unzipper.ts";
import { XLSXConverter } from "./postprocess/xlsx_converter.ts";
import { Command } from "./postprocess/command.ts";

const initDimFile = async () => {
  const dimData: DimJSON = { fileVersion: DIM_FILE_VERSION, contents: [] };
  await ensureFile(DEFAULT_DIM_FILE_PATH);
  return await Deno.writeTextFile(
    DEFAULT_DIM_FILE_PATH,
    JSON.stringify(dimData, null, 2),
  );
};

const initDimLockFile = async () => {
  const dimLockData: DimLockJSON = {
    lockFileVersion: DIM_LOCK_FILE_VERSION,
    contents: [],
  };
  await ensureFile(DEFAULT_DIM_LOCK_FILE_PATH);
  return await Deno.writeTextFile(
    DEFAULT_DIM_LOCK_FILE_PATH,
    JSON.stringify(dimLockData, null, 2),
  );
};

const createDataFilesDir = async () => {
  await ensureDir(DEFAULT_DATAFILES_PATH);
};

const installFromURL = async (
  url: string,
  postProcesses?: string[],
  name?: string,
  headers?: Record<string, string>,
  isUpdate = false,
) => {
  const dimLockFileAccessor = new DimLockFileAccessor();
  const isInstalled = dimLockFileAccessor.getContents().some((
    lockContent,
  ) => lockContent.url === url);
  if (isInstalled && !isUpdate) {
    console.log("The url have already been installed.");
    Deno.exit(0);
  }
  return await Promise.all([
    new Downloader().download(new URL(url), headers),
    new DimFileAccessor().addContent(
      url,
      name || url,
      postProcesses || [],
      headers || {},
    ),
  ]);
};

const installFromDimFile = async (isUpdate = false) => {
  let contents = new DimFileAccessor().getContents();
  if (contents.length == 0) {
    console.log("No contents.\nYou should run a 'dim install <data url>'. ");
    return;
  }
  const dimLockFileAccessor = new DimLockFileAccessor();
  if (!isUpdate) {
    const isNotInstalled = (content: Content) =>
      dimLockFileAccessor.getContents().every((lockContent) =>
        lockContent.url !== content.url
      );
    contents = contents.filter(isNotInstalled);
  }
  const downloadList = contents.map((content) => {
    return new Promise<LockContent>((resolve) => {
      const consoleAnimation = new ConsoleAnimation(
        ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
        `Installing ${content.url} ...`,
      );
      consoleAnimation.start(100);
      new Downloader().download(new URL(content.url)).then(async (result) => {
        consoleAnimation.stop();
        await executePostprocess(content.postProcesses, result.fullPath);
        console.log(
          Colors.green(`Installed to ${result.fullPath}`),
        );
        console.log();
        resolve({
          name: content.name,
          url: content.url,
          path: result.fullPath,
          catalogUrl: null,
          catalogResourceId: null,
          lastModified: null,
          eTag: null,
          lastDonwloaded: new Date(),
          integrity: "",
          postProcesses: content.postProcesses,
          headers: {},
        });
      });
    });
  });
  return await Promise.all(downloadList);
};
const executePostprocess = async (
  postProcesses: string[],
  targetPath: string,
) => {
  for (const p of postProcesses) {
    if (p.startsWith("encoding-")) {
      const encodingTo = p.replace("encoding-", "").toUpperCase();
      await new Encoder().encodeFile(targetPath, encodingTo);
      console.log("Converted encoding to", encodingTo);
    } else if (p === "unzip") {
      const targetDir = await new Unzipper().unzip(targetPath);
      console.log(`Unzip the file to ${targetDir}`);
    } else if (p === "xlsx-to-csv") {
      await new XLSXConverter().convertToCSV(targetPath);
      console.log(`Convert xlsx to csv.`);
    } else if (p.startsWith("CMD:")) {
      const script = p.replace("CMD:", "");
      await new Command().execute(script, targetPath);
      console.log("Execute Command: ", script, targetPath);
    } else {
      console.log(`No support a postprocess '${p}'.`);
    }
  }
};

export const parseHeader = function (
  headers: string[] | undefined,
): Record<string, string> {
  const parsedHeaders: Record<string, string> = {};
  if (headers !== undefined) {
    for (const header of headers) {
      const [key, value] = header.split(/:\s*/);
      parsedHeaders[key] = value;
    }
  }
  return parsedHeaders;
};

export class InitAction {
  async execute(options: any) {
    await createDataFilesDir();
    await initDimFile();
    await initDimLockFile();
    console.log(Colors.green("Initialized the project for the dim."));
  }
}

export class InstallAction {
  async execute(
    options: { postProcesses?: string[]; name?: string; headers?: string[] },
    url: string | undefined,
  ) {
    await createDataFilesDir();
    if (!existsSync(DEFAULT_DIM_LOCK_FILE_PATH)) {
      await initDimLockFile();
    }

    const parsedHeaders: Record<string, string> = parseHeader(options.headers);

    if (url !== undefined) {
      const targetContent = new DimFileAccessor().getContents().find((c) =>
        c.url === url || c.name === options.name
      );
      if (targetContent !== undefined) {
        console.log("The name already exists.");
        Deno.exit(0);
      }
      const results = await installFromURL(
        url,
        options.postProcesses,
        options.name,
        parsedHeaders,
      ).catch(
        (error) => {
          console.error(
            Colors.red("Failed to install."),
            Colors.red(error.message),
          );
          Deno.exit(0);
        },
      );
      const fullPath = results[0].fullPath;
      const lockContent: LockContent = {
        name: options.name || url,
        url: url,
        path: fullPath,
        catalogUrl: null,
        catalogResourceId: null,
        lastModified: null,
        eTag: null,
        lastDonwloaded: new Date(),
        integrity: "",
        postProcesses: options.postProcesses || [],
        headers: parsedHeaders,
      };
      if (options.postProcesses !== undefined) {
        await executePostprocess(options.postProcesses, fullPath);
      }
      await new DimLockFileAccessor().addContent(lockContent);
      console.log(
        Colors.green(`Installed to ${fullPath}`),
      );
    } else {
      const lockContentList = await installFromDimFile().catch((error) => {
        console.error(
          Colors.red("Failed to install."),
          Colors.red(error.message),
        );
        Deno.exit(0);
      });
      if (lockContentList !== undefined) {
        await new DimLockFileAccessor().addContents(lockContentList);
        if (lockContentList.length != 0) {
          console.log(
            Colors.green(`Successfully installed.`),
          );
        } else {
          console.log("All contents have already been installed.");
        }
      }
    }
  }
}

export class UninstallAction {
  async execute(options: any, url: string) {
    const isRemovedDimFile = await new DimFileAccessor().removeContent(url);
    if (isRemovedDimFile) {
      console.log(
        Colors.green("Removed a content from the dim.json."),
      );
    } else {
      console.log(
        Colors.red("Faild to remove. Not Found a content in the dim.json."),
      );
    }
    const dimLockFileAccessor = new DimLockFileAccessor();
    const targetContent = dimLockFileAccessor.getContents().find((c) =>
      c.url === url || c.name === url
    );
    const isRemovedDimLockFile = await dimLockFileAccessor.removeContent(url);
    if (isRemovedDimLockFile) {
      console.log(
        Colors.green("Removed a content from the dim-lock.json."),
      );
    } else {
      console.log(
        Colors.red(
          "Faild to remove. Not Found a content in the dim-lock.json.",
        ),
      );
    }
    if (targetContent !== undefined) {
      if (existsSync(targetContent.path)) {
        await Deno.remove(targetContent.path);
        console.log(
          Colors.green(`Removed a file '${targetContent.path}'.`),
        );
      }
      // TODO: Remove an empty direcotory
    }
  }
}

export class ListAction {
  execute(
    options: { simple?: boolean },
  ): void {
    const contents = new DimLockFileAccessor().getContents();
    contents.forEach((content) => {
      if (options.simple == true) {
        console.log(
          content.name,
          content.url,
          content.path,
          content.catalogUrl,
          content.catalogResourceId,
          content.lastModified,
          content.eTag,
          content.lastDonwloaded,
          content.integrity,
          content.postProcesses.join(","),
          content.headers,
        );
      } else {
        console.log(
          content.name,
        );
        console.log(
          "  - URL               :",
          Colors.green(content.url),
        );
        console.log(
          "  - Name              :",
          Colors.green(content.name),
        );
        console.log(
          "  - File path         :",
          Colors.green(content.path),
        );
        console.log(
          "  - Catalog URL       :",
          Colors.green(
            content.catalogUrl === null ? "null" : content.catalogUrl,
          ),
        );
        console.log(
          "  - Catalog resourceid:",
          Colors.green(
            content.catalogResourceId === null
              ? "null"
              : content.catalogResourceId,
          ),
        );
        console.log(
          "  - Last modified     :",
          Colors.green(
            content.lastModified === null
              ? "null"
              : content.lastDonwloaded.toString(),
          ),
        );
        console.log(
          "  - ETag              :",
          Colors.green(content.eTag === null ? "null" : content.eTag),
        );
        console.log(
          "  - Last donwloaded   :",
          Colors.green(content.lastDonwloaded.toString()),
        );
        console.log(
          "  - Integrity         :",
          Colors.green(content.integrity),
        );
        console.log(
          "  - Post processes    :",
          Colors.green(content.postProcesses.join(", ")),
        );
        console.log(
          "  - Headers           :",
          Colors.green(JSON.stringify(content.headers)),
        );
        console.log();
      }
    });
  }
}

export class UpdateAction {
  async execute(
    options: { postProcesses?: string[]; name?: string },
    url: string | undefined,
  ) {
    await createDataFilesDir();
    if (!existsSync(DEFAULT_DIM_LOCK_FILE_PATH)) {
      await initDimLockFile();
    }

    if (url !== undefined) {
      const results = await installFromURL(
        url,
        options.postProcesses,
        options.name,
        {},
        true,
      ).catch(
        (error) => {
          console.error(
            Colors.red("Failed to update."),
            Colors.red(error.message),
          );
          Deno.exit(0);
        },
      );
      const fullPath = results[0].fullPath;
      const lockContent: LockContent = {
        name: url,
        url: url,
        path: fullPath,
        catalogUrl: null,
        catalogResourceId: null,
        lastModified: null,
        eTag: null,
        lastDonwloaded: new Date(),
        integrity: "",
        postProcesses: options.postProcesses || [],
        headers: {},
      };
      if (options.postProcesses !== undefined) {
        await executePostprocess(options.postProcesses, fullPath);
      }
      await new DimLockFileAccessor().addContent(lockContent);
      console.log(
        Colors.green(`Updated ${url}.`),
        `\nFile path:`,
        Colors.yellow(fullPath),
      );
    } else {
      const lockContentList = await installFromDimFile(true).catch((error) => {
        console.error(
          Colors.red("Failed to update."),
          Colors.red(error.message),
        );
        Deno.exit(0);
      });
      if (lockContentList !== undefined) {
        await new DimLockFileAccessor().addContents(lockContentList);
      }
      console.log(
        Colors.green(`Successfully Updated.`),
      );
    }
  }
}
