// @FileName  :vmp_log_optimized.js
// @Time      :2025-12-16
// @Author    :Optimized based on suggestions
const parse = require("@babel/parser").parse;
const traverse = require("@babel/traverse").default;
const generator = require("@babel/generator").default;
const fs = require("fs");
const type = require("@babel/types");

// 读取代码
let js_code = fs.readFileSync("vmp_demo.js", encoding = "utf-8");
let ast = parse(js_code);

// FIX 1: 使用 WeakMap 替代 node.flag
const nodeLogMap = new WeakMap();

// FIX 9: 修复数组检查 bug，并添加防调试包装
function insert_log(log_arguments) {
    // 修复优先级问题: !arr instanceof Array 会先计算 !arr
    if (!Array.isArray(log_arguments)) {
        throw new Error("入参应该是数组类型");
    }
    let object_name = "console";
    let property_name = "log";
    let property_create = type.identifier(property_name);
    let object_create = type.identifier(object_name);
    let MemberExpression_create = type.memberExpression(object_create, property_create);
    let callExpression_create = type.callExpression(MemberExpression_create, log_arguments);

    // FIX 5: 添加环境检测
    let condition = type.memberExpression(type.identifier("window"), type.identifier("debugMode"));
    let conditionalExpr = type.conditionalExpression(
        condition,
        callExpression_create,
        type.unaryExpression("void", type.numericLiteral(0))
    );

    return type.expressionStatement(conditionalExpr);
}

function createSafeStringLiteral(value) {
    const node = type.stringLiteral(value);
    node.extra = {
        raw: JSON.stringify(value),
        rawValue: value
    };
    return node;
}

// 步骤 1: 预处理索引
// 将 e[I[++k]] 修改为 e[I[k-n]]，以便在 console.log 中能引用到正确的值，而不触发副作用(++k)
traverse(ast, {
    ExpressionStatement: function (path) {
        let {node, parentPath, getNextSibling} = path;
        // VMP 典型的 switch-case 结构判断
        if (!type.isSwitchCase(parentPath) && !type.isBreakStatement(getNextSibling)) return;
        let {expression} = node;
        if (!type.isAssignmentExpression(expression)) return;

        let updateExpressions = [];
        path.traverse({
            UpdateExpression(_path) {
                updateExpressions.push(_path);
            }
        });

        // 逆序处理，确保索引计算正确
        updateExpressions.reverse().forEach((_path, index) => {
            let countValue = index;
            let binaryExpression_create = type.binaryExpression(
                "-",
                type.identifier("k"),
                type.numericLiteral(countValue)
            );
            _path.parentPath.node.property = binaryExpression_create;
        });
    }
});

// 步骤 2: 分析逻辑并构建插桩节点
traverse(ast, {
    ExpressionStatement: function (path) {
        let {node, parentPath, getNextSibling} = path;
        if (!type.isSwitchCase(parentPath) && !type.isBreakStatement(getNextSibling)) return;
        let {expression} = node;
        if (!type.isAssignmentExpression(expression)) return;

        let {left, right, operator} = expression;
        if (!type.isMemberExpression(left)) return;
        if (operator !== "=") return;

        let return_string = "返回值===>";
        let return_string_create = createSafeStringLiteral(return_string);
        let log_args = null;

        // FIX 2 & 7: 增加对 Unary, Update, Array 的支持
        if (type.isBinaryExpression(right)) {
            let operator_list = ["+", "-", "*", "/", "%", "==", "===", "<", "<=", ">", "<<", ">>", "<<<", ">>>", "|", "^", "&", ">=", "in", "instanceof"];
            if (operator_list.includes(right.operator)) {
                let stringLiteral_create = createSafeStringLiteral("运算===>");
                let binaryExpression_create = type.binaryExpression(right.operator, type.cloneNode(right.left), type.cloneNode(right.right));
                log_args = [stringLiteral_create, binaryExpression_create, return_string_create, type.cloneNode(left)];
            }
        }
        else if (type.isUnaryExpression(right)) {
             let stringLiteral_create = createSafeStringLiteral("一元运算===>");
             let unaryExpression_create = type.unaryExpression(right.operator, type.cloneNode(right.argument));
             log_args = [stringLiteral_create, unaryExpression_create, return_string_create, type.cloneNode(left)];
        }
        else if (type.isUpdateExpression(right)) {
             let stringLiteral_create = createSafeStringLiteral("更新运算===>");
             let updateExpression_create = type.updateExpression(right.operator, type.cloneNode(right.argument), right.prefix);
             log_args = [stringLiteral_create, updateExpression_create, return_string_create, type.cloneNode(left)];
        }
        else if (type.isArrayExpression(right)) {
             let stringLiteral_create = createSafeStringLiteral("数组定义===>");
             log_args = [stringLiteral_create, type.cloneNode(right), return_string_create, type.cloneNode(left)];
        }
        // FIX 3: 增加对 bind 和 new 的支持
        else if (type.isCallExpression(right) || type.isNewExpression(right)) {
            let callee = right.callee;
            let isNew = type.isNewExpression(right);
            let args = right.arguments;

            // 处理 call/apply/bind 等方法调用
            if (type.isMemberExpression(callee)) {
                let property_name = callee.property.name;
                let object = callee.object;

                if (!isNew && (property_name === "call" || property_name === "apply" || property_name === "bind")) {
                    let opName = property_name === "bind" ? "bind func ===>" : "func ===>";
                    let first_stringLiteral_create = createSafeStringLiteral(opName);
                    let this_string_create = createSafeStringLiteral("this===>");

                    let this_arg = args.length > 0 ? type.cloneNode(args[0]) : type.identifier("undefined");

                    log_args = [first_stringLiteral_create, type.cloneNode(object), this_string_create, this_arg];

                    if (property_name === "apply") {
                        if (args.length > 1) {
                            log_args.push(createSafeStringLiteral("args_array===>"));
                            log_args.push(type.cloneNode(args[1]));
                        }
                    } else {
                         for (let i = 1; i < args.length; i++) {
                             log_args.push(createSafeStringLiteral(`arg${i}===>`));
                             log_args.push(type.cloneNode(args[i]));
                         }
                    }
                    log_args.push(return_string_create);
                    log_args.push(type.cloneNode(left));

                } else {
                    // 普通的对象方法调用 e.g., obj.method()
                    let prefix = isNew ? "new Call===>" : "Method Call===>";
                    log_args = [createSafeStringLiteral(prefix), type.cloneNode(callee)];
                    args.forEach((arg, i) => {
                        log_args.push(createSafeStringLiteral(`arg${i}===>`));
                        log_args.push(type.cloneNode(arg));
                    });
                    log_args.push(return_string_create);
                    log_args.push(type.cloneNode(left));
                }
            } else {
                // 直接函数调用
                let prefix = isNew ? "new Call===>" : "Func Call===>";
                log_args = [createSafeStringLiteral(prefix), type.cloneNode(callee)];
                args.forEach((arg, i) => {
                    log_args.push(createSafeStringLiteral(`arg${i}===>`));
                    log_args.push(type.cloneNode(arg));
                });
                log_args.push(return_string_create);
                log_args.push(type.cloneNode(left));
            }
        }

        if (log_args) {
            let log_statement = insert_log(log_args);
            // 将生成的日志节点存入 WeakMap，等待后续插入
            nodeLogMap.set(node, log_statement);
        }
    }
});

// 步骤 3: 还原索引
// 将步骤1中修改的 k-n 还原回 ++k，保证 VMP 自身的逻辑执行正确
traverse(ast, {
    ExpressionStatement: function (path) {
        let {node, parentPath, getNextSibling} = path;
        if (!type.isSwitchCase(parentPath) && !type.isBreakStatement(getNextSibling)) return;
        let {expression} = node;
        if (!type.isAssignmentExpression(expression)) return;

        let operator = "++";
        let in_argument = type.identifier("k");

        path.traverse({
            BinaryExpression(_path) {
                // 严谨判断：只还原左侧为 k 且操作符为 - 的表达式
                if (_path.node.operator === '-' && type.isIdentifier(_path.node.left, {name: 'k'})) {
                    _path.parentPath.node.property = type.updateExpression(operator, in_argument, true);
                }
            }
        });
    }
});

// 步骤 4: 执行插入
traverse(ast, {
    ExpressionStatement: function (path) {
        if (nodeLogMap.has(path.node)) {
            let insert_node = nodeLogMap.get(path.node);
            path.insertAfter(insert_node);
            // FIX 6: 跳过新插入的节点，防止重复遍历造成死循环或错误
            path.skip();
        }
    }
});

// FIX 8: 生成代码时保留注释，方便调试对照
let code = generator(ast, { comments: true }).code;
fs.writeFileSync("./vmp_demo插桩后.js", code, "utf-8");