/**
 * 浏览器/DOM 测试 - 客户端 UI 渲染和响应式布局
 * 使用 vitest 内置的 happy-dom 环境
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from "vitest";

describe("浏览器/DOM 测试", () => {
  describe("客户端 UI 渲染", () => {
    it("创建基本 DOM 元素", () => {
      const div = document.createElement("div");
      div.className = "mw-card";
      div.textContent = "测试内容";
      document.body.appendChild(div);

      expect(document.querySelector(".mw-card")).toBeTruthy();
      expect(document.querySelector(".mw-card")?.textContent).toBe("测试内容");
    });

    it("创建表单元素", () => {
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.type = "text";
      input.name = "testInput";
      input.value = "test value";
      form.appendChild(input);
      document.body.appendChild(form);

      const foundInput = document.querySelector('input[name="testInput"]') as HTMLInputElement;
      expect(foundInput).toBeTruthy();
      expect(foundInput.value).toBe("test value");
    });

    it("创建按钮并模拟点击", () => {
      let clicked = false;
      const button = document.createElement("button");
      button.textContent = "点击测试";
      button.addEventListener("click", () => {
        clicked = true;
      });
      document.body.appendChild(button);

      button.click();
      expect(clicked).toBe(true);
    });

    it("创建列表元素", () => {
      const ul = document.createElement("ul");
      ["项目 1", "项目 2", "项目 3"].forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      });
      document.body.appendChild(ul);

      const items = document.querySelectorAll("li");
      expect(items.length).toBe(3);
      expect(items[0].textContent).toBe("项目 1");
    });

    it("创建包含类名的复杂结构", () => {
      const container = document.createElement("div");
      container.className = "mw-container";

      const header = document.createElement("div");
      header.className = "mw-header";
      header.textContent = "标题";

      const content = document.createElement("div");
      content.className = "mw-content";
      content.textContent = "内容";

      container.appendChild(header);
      container.appendChild(content);
      document.body.appendChild(container);

      expect(document.querySelector(".mw-container .mw-header")?.textContent).toBe("标题");
      expect(document.querySelector(".mw-container .mw-content")?.textContent).toBe("内容");
    });
  });

  describe("响应式布局", () => {
    it("检测视口宽度", () => {
      expect(window.innerWidth).toBeGreaterThan(0);
    });

    it("CSS 样式支持", () => {
      const div = document.createElement("div");
      div.style.width = "100px";
      div.style.height = "50px";
      document.body.appendChild(div);

      expect(div.style.width).toBe("100px");
      expect(div.style.height).toBe("50px");
    });

    it("动态添加和移除类名", () => {
      const div = document.createElement("div");
      div.className = "initial";
      document.body.appendChild(div);

      expect(div.classList.contains("initial")).toBe(true);

      div.classList.add("active");
      expect(div.classList.contains("active")).toBe(true);

      div.classList.remove("initial");
      expect(div.classList.contains("initial")).toBe(false);
    });

    it("元素显示/隐藏切换", () => {
      const div = document.createElement("div");
      div.style.display = "block";
      document.body.appendChild(div);

      expect(div.style.display).toBe("block");

      div.style.display = "none";
      expect(div.style.display).toBe("none");
    });
  });

  describe("表单交互", () => {
    it("input 值变化", () => {
      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);

      input.value = "初始值";
      expect(input.value).toBe("初始值");

      input.value = "更新值";
      expect(input.value).toBe("更新值");
    });

    it("checkbox 状态切换", () => {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      document.body.appendChild(checkbox);

      expect(checkbox.checked).toBe(false);

      checkbox.checked = true;
      expect(checkbox.checked).toBe(true);
    });

    it("select 选项选择", () => {
      const select = document.createElement("select");
      ["选项1", "选项2", "选项3"].forEach((text, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = text;
        select.appendChild(option);
      });
      document.body.appendChild(select);

      select.value = "1";
      expect(select.value).toBe("1");
      expect(select.options[select.selectedIndex].textContent).toBe("选项2");
    });

    it("textarea 多行文本", () => {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      const multilineText = "第一行\n第二行\n第三行";
      textarea.value = multilineText;
      expect(textarea.value).toBe(multilineText);
    });
  });

  describe("事件处理", () => {
    it("多个事件监听器", () => {
      const button = document.createElement("button");
      let count1 = 0;
      let count2 = 0;

      button.addEventListener("click", () => count1++);
      button.addEventListener("click", () => count2++);

      button.click();
      expect(count1).toBe(1);
      expect(count2).toBe(1);

      button.click();
      expect(count1).toBe(2);
      expect(count2).toBe(2);
    });

    it("事件冒泡", () => {
      const parent = document.createElement("div");
      const child = document.createElement("button");
      parent.appendChild(child);
      document.body.appendChild(parent);

      let parentClicked = false;
      let childClicked = false;

      parent.addEventListener("click", () => {
        parentClicked = true;
      });

      child.addEventListener("click", () => {
        childClicked = true;
      });

      child.click();
      expect(childClicked).toBe(true);
      expect(parentClicked).toBe(true);
    });

    it("preventDefault 阻止默认行为", () => {
      const form = document.createElement("form");
      let defaultPrevented = false;

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        defaultPrevented = true;
      });

      document.body.appendChild(form);

      const event = new Event("submit", { cancelable: true });
      form.dispatchEvent(event);

      expect(defaultPrevented).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe("DOM 操作性能", () => {
    it("批量创建元素", () => {
      const fragment = document.createDocumentFragment();

      for (let i = 0; i < 100; i++) {
        const div = document.createElement("div");
        div.textContent = `Item ${i}`;
        fragment.appendChild(div);
      }

      document.body.appendChild(fragment);
      const createdDivs = document.querySelectorAll("div");
      expect(createdDivs.length).toBeGreaterThanOrEqual(100);
    });

    it("querySelector 性能", () => {
      const container = document.createElement("div");
      container.id = "test-container";

      for (let i = 0; i < 50; i++) {
        const item = document.createElement("div");
        item.className = "item";
        item.dataset.index = String(i);
        container.appendChild(item);
      }

      document.body.appendChild(container);

      const found = document.querySelector("#test-container .item[data-index='25']");
      expect(found).toBeTruthy();
      expect(found?.getAttribute("data-index")).toBe("25");
    });
  });
});
