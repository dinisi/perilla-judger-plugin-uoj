"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const puppeteer_1 = require("puppeteer");
const interfaces_1 = require("./interfaces");
const MAX_SOURCE_SIZE = 16 * 1024 * 1024;
const UPDATE_INTERVAL = 1000;
const config = JSON.parse(fs_1.readFileSync("config.json").toString());
let browser = null;
if (!config.uoj_addr.endsWith("/")) {
    config.uoj_addr = config.uoj_addr + "/";
}
const getURL = (url) => {
    if (url.startsWith("/")) {
        return config.uoj_addr + url.substr(1);
    }
    return config.uoj_addr + url;
};
const isLoggedIn = async () => {
    if (!browser) {
        return false;
    }
    const page = await browser.newPage();
    try {
        const res = await page.goto(getURL("user/msg"));
        const failed = (res.status() !== 200) || !(/私信/.test(await res.text()));
        await page.close();
        return !failed;
    }
    catch (e) {
        await page.close();
        return false;
    }
};
const initRequest = async () => {
    console.log("[INFO] [UOJ] Puppeteer is initializing");
    browser = await puppeteer_1.launch({ headless: false });
    const page = await browser.newPage();
    try {
        await page.goto(getURL("login"));
        await page.evaluate((username, password) => {
            const usr = document.querySelector("#input-username");
            const pwd = document.querySelector("#input-password");
            usr.value = username;
            pwd.value = password;
            const btn = document.querySelector("#button-submit");
            btn.click();
        }, config.username, config.password);
        await page.waitForNavigation();
        if (!await isLoggedIn()) {
            throw new Error("Login failed");
        }
        await page.close();
        console.log("[INFO] [UOJ] Puppeteer is initialized");
    }
    catch (e) {
        await page.close();
        throw e;
    }
};
const submit = async (id, code, langname) => {
    const page = await browser.newPage();
    try {
        await page.goto(getURL("problem/" + id));
        const success = await page.evaluate((lang, sourcecode) => {
            const submitBtn = document.querySelector("body > div.container.theme-showcase > div.uoj-content > ul > li:nth-child(2) > a");
            if (!submitBtn) {
                return false;
            }
            submitBtn.click();
            const langEle = document.querySelector("#input-answer_answer_language");
            if (!langEle) {
                return false;
            }
            const codeEle = document.querySelector("#input-answer_answer_editor");
            if (!codeEle) {
                return false;
            }
            langEle.value = lang;
            codeEle.value = sourcecode;
            const btn = document.querySelector("#button-submit-answer");
            btn.click();
            return true;
        }, langname, code);
        if (!success) {
            throw new Error("Submit failed");
        }
        await page.waitForNavigation();
        const unparsedID = await page.evaluate((username) => {
            const tbody = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody");
            for (let i = 0; i < tbody.children.length; i++) {
                const tr = tbody.children[i];
                if (tr.getAttribute("class") === "info") {
                    continue;
                }
                const user = tr.children[2].textContent.trim();
                if (user === username) {
                    return tr.children[0].textContent.trim().substr(1);
                }
            }
            return null;
        }, config.username);
        if (unparsedID === null) {
            throw new Error("Submit failed");
        }
        await page.close();
        return parseInt(unparsedID, 10);
    }
    catch (e) {
        await page.close();
        throw e;
    }
};
const updateMap = new Map();
const convertStatus = (text) => {
    try {
        const score = parseInt(text, 10);
        if (score < 0 || score > 100 || isNaN(score)) {
            throw new Error("Invalid score");
        }
        return {
            score,
            status: score === 100 ? interfaces_1.SolutionResult.Accepted : interfaces_1.SolutionResult.OtherError,
        };
    }
    catch (e) {
        switch (text) {
            case "Waiting":
            case "Waiting Rejudge":
                return { status: interfaces_1.SolutionResult.WaitingJudge, score: 0 };
            case "Compiling":
            case "Judging":
                return { status: interfaces_1.SolutionResult.Judging, score: 0 };
            case "Compile Error":
                return { status: interfaces_1.SolutionResult.CompileError, score: 0 };
            case "Judgement Failed":
                return { status: interfaces_1.SolutionResult.JudgementFailed, score: 0 };
        }
        return {
            status: interfaces_1.SolutionResult.OtherError,
            score: 0,
        };
    }
};
const fetch = async (runID) => {
    const page = await browser.newPage();
    try {
        await page.goto(getURL("submission/" + runID));
        const { memory, time, statusText } = await page.evaluate(() => {
            const mEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(5)");
            const tEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(6)");
            const sEle = document.querySelector("body > div > div.uoj-content > div.table-responsive > table > tbody > tr > td:nth-child(4)");
            return {
                memory: mEle.textContent.trim(),
                time: tEle.textContent.trim(),
                statusText: sEle.textContent.trim(),
            };
        });
        const { status, score } = convertStatus(statusText);
        const result = {
            status,
            score,
            details: {
                time,
                memory,
            },
        };
        await page.close();
        return result;
    }
    catch (e) {
        await page.close();
        throw e;
    }
};
const updateSolutionResults = async () => {
    for (const [runid, cb] of updateMap) {
        try {
            const result = await fetch(runid);
            cb(result);
            if (result.status !== interfaces_1.SolutionResult.Judging && result.status !== interfaces_1.SolutionResult.WaitingJudge) {
                updateMap.delete(runid);
            }
        }
        catch (e) {
            cb({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
        }
    }
    setTimeout(updateSolutionResults, UPDATE_INTERVAL);
};
const main = async (problem, solution, resolve, update) => {
    if (interfaces_1.Problem.guard(problem)) {
        if (interfaces_1.Solution.guard(solution)) {
            if (!browser) {
                try {
                    await initRequest();
                }
                catch (e) {
                    browser = null;
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: e.message } });
                }
            }
            try {
                let langname = null;
                if (solution.language === "c") {
                    langname = "C";
                }
                else if (solution.language === "cpp98") {
                    langname = "C++";
                }
                else if (solution.language === "cpp11") {
                    langname = "C++11";
                }
                else if (solution.language === "java") {
                    langname = "Java8";
                }
                else if (solution.language === "python3") {
                    langname = "Python3";
                }
                else if (solution.language === "python2") {
                    langname = "Python2.7";
                }
                if (langname === null) {
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Language rejected" } });
                }
                const source = await resolve(solution.file);
                const stat = fs_1.statSync(source.path);
                if (stat.size > MAX_SOURCE_SIZE) {
                    return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "File is too big" } });
                }
                const content = fs_1.readFileSync(source.path).toString();
                const runID = await submit(problem.id, content, langname);
                updateMap.set(runID, update);
            }
            catch (e) {
                return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
            }
        }
        else {
            return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid solution" } });
        }
    }
    else {
        return update({ status: interfaces_1.SolutionResult.JudgementFailed, score: 0, details: { error: "Invalid problem" } });
    }
};
module.exports = main;
updateSolutionResults();
//# sourceMappingURL=index.js.map