var _ = require('lodash');
var pathToRegexp = require('path-to-regexp');

var swagger = {
	swagger	: "2.0",
	info	: {},
	paths	: {},
	definitions: {}
};

function toSwagger(apidocJson, projectJson, bracketFormat, prependPath) {
	swagger.info = addInfo(projectJson);
	swagger.paths = extractPaths(apidocJson, bracketFormat, prependPath);
	return swagger;
}

var tagsRegex = /(<([^>]+)>)/ig;
// Removes <p> </p> tags from text
function removeTags(text) {
	return text ? text.replace(tagsRegex, "") : text;
}

function addInfo(projectJson) {
	var info = {};
	info["title"] = projectJson.title || projectJson.name;
	info["version"] = projectJson.version;
	info["description"] = projectJson.description;
	return info;
}


/**
 * For string Replace function to change {id} format to :id syntax to generalize. Does not support :id{-:suffix} syntax
 * @param match A single matched part from String.prototype.replace
 * @returns string Colon prefixed version of the path parameter
  */
function replaceBrackets(match) {
	return ':' + match.slice(1, -1);
}

/**
 * Extracts paths provided in json format
 * post, patch, put request parameters are extracted in body
 * get and delete are extracted to path parameters
 * @param apidocJson
 * @param bracketFormat Parses bracket formatted path parameters
 * @param prependPath Prepends to the beginning of the path. Do not put a trailing slash
 * @returns {{}}
 */
function extractPaths(apidocJson, bracketFormat = false, prependPath = ''){
	var apiPaths = groupByUrl(apidocJson);
	var paths = {};
	for (var i = 0; i < apiPaths.length; i++) {
		var verbs = apiPaths[i].verbs;
		var url = verbs[0].url;

		if (bracketFormat) {
			url = url.replace(/\{.*\}/gi, replaceBrackets);
		}

		if (prependPath) {
			url = prependPath + url;
		}

		var pattern = pathToRegexp(url, null);
		var matches = pattern.exec(url);

		// Surrounds URL parameters with curly brackets -> :email with {email}
		var pathKeys = [];
		for (var j = 1; j < matches.length; j++) {
			var key = matches[j].substr(1);
			url = url.replace(matches[j], "{"+ key +"}");
			pathKeys.push(key);
		}

		for(var j = 0; j < verbs.length; j++) {
			var verb = verbs[j];
			var type = verb.type;

			var obj = paths[url] = paths[url] || {};

			if (type == 'post' || type == 'patch' || type == 'put') {
				_.extend(obj, createPostPushPutOutput(verb, swagger.definitions, pathKeys));
			} else {
				_.extend(obj, createGetDeleteOutput(verb, swagger.definitions, pathKeys));
			}
		}
	}
	return paths;
}

function createPostPushPutOutput(verbs, definitions, pathKeys) {
	var pathItemObject = {};
	var verbDefinitionResult = createVerbDefinitions(verbs,definitions);

	var params = [];
	var pathParams = createPathParameters(verbs);
	pathParams = _.filter(pathParams, function(param) {
		var hasKey = pathKeys.indexOf(param.name) !== -1;
		return !(param.in === "path" && !hasKey)
	});

	params = params.concat(pathParams);
	var required = verbs.parameter && verbs.parameter.fields && 
					verbs.parameter.fields.Parameter && verbs.parameter.fields.Parameter.length > 0;

	params.push({
			"in": "body",
			"name": "body",
			"description": removeTags(verbs.description),
			"required": required,
			"schema": {
				"$ref": "#/definitions/" + verbDefinitionResult.topLevelParametersRef
			}
		});
	
	pathItemObject[verbs.type] = {
		tags: [verbs.group],
		summary: removeTags(verbs.description),
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: params
	}

	if (verbDefinitionResult.topLevelSuccessRef) {
		const match = verbDefinitionResult.topLevelSuccessRefType && verbDefinitionResult.topLevelSuccessRefType.match(/\w+(?=\[])/);
		pathItemObject[verbs.type].responses = {
          "200": {
            "description": "successful operation",
            "schema": {
              "type": match ? "array" : verbDefinitionResult.topLevelSuccessRefType,
              "items": {
                "$ref": "#/definitions/" + verbDefinitionResult.topLevelSuccessRef
              }
            }
          }
      	};
	}
	
	return pathItemObject;
}

function createVerbDefinitions(verbs, definitions) {
	var result = {
		topLevelParametersRef : null,
		topLevelSuccessRef : null,
		topLevelSuccessRefType : null
	};
	var defaultObjectName = verbs.name;

	var fieldArrayResult = {};
	if (verbs && verbs.parameter && verbs.parameter.fields) {
		fieldArrayResult = createFieldArrayDefinitions(verbs.parameter.fields.Parameter, definitions, verbs.name, defaultObjectName);		
		result.topLevelParametersRef = fieldArrayResult.topLevelRef;
	};

	if (verbs && verbs.success && verbs.success.fields) {
		fieldArrayResult = createFieldArrayDefinitions(verbs.success.fields["Success 200"], definitions, verbs.name, defaultObjectName);		
		result.topLevelSuccessRef = fieldArrayResult.topLevelRef;
		result.topLevelSuccessRefType = fieldArrayResult.topLevelRefType;
	};

	return result;
}

function createFieldArrayDefinitions(fieldArray, definitions, topLevelRef, defaultObjectName) {
	var result = {
		topLevelRef : topLevelRef,
		topLevelRefType : null
	}

	if (!fieldArray) {
		return result;
	}

	for (var i = 0; i < fieldArray.length; i++) {
		var parameter = fieldArray[i];

		var nestedName = createNestedName(parameter.field);
		var objectName = nestedName.objectName;
		if (!objectName) {
			objectName = defaultObjectName;
		}
		var type = parameter.type;
		if (i == 0) {
			result.topLevelRefType = type;
			if(parameter.type == "Object") {
				objectName = nestedName.propertyName;
				nestedName.propertyName = null;
			} else if (parameter.type == "Array") {
				objectName = nestedName.propertyName;
				nestedName.propertyName = null;				
				result.topLevelRefType = "array";
			}
			result.topLevelRef = objectName;
		};

		definitions[objectName] = definitions[objectName] ||
			{ properties : {}, required : [] };

		if (nestedName.propertyName) {
			var prop = { type: (parameter.type || "").toLowerCase(), description: removeTags(parameter.description) };
			if(parameter.type == "Object") {
				prop.$ref = "#/definitions/" + parameter.field;
			}

			var typeIndex = type.indexOf("[]");
			if(typeIndex !== -1 && typeIndex === (type.length - 2)) {
				prop.type = "array";
				prop.items = {
					type: type.slice(0, type.length-2)
				};
			}

			definitions[objectName]['properties'][nestedName.propertyName] = prop;
			if (!parameter.optional) {
				var arr = definitions[objectName]['required'];
				if(arr.indexOf(nestedName.propertyName) === -1) {
					arr.push(nestedName.propertyName);
				}
			};

		};
	}

	return result;
}

function createNestedName(field) {
	var propertyName = field;
	var objectName;
	var propertyNames = field.split(".");
	if(propertyNames && propertyNames.length > 1) {
		propertyName = propertyNames[propertyNames.length-1];
		propertyNames.pop();
		objectName = propertyNames.join(".");
	}

	return {
		propertyName: propertyName,
		objectName: objectName
	}
}


/**
 * Generate get, delete method output
 * @param verbs
 * @param definitions
 * @param pathKeys
 * @returns {{}}
 */
function createGetDeleteOutput(verbs, definitions, pathKeys) {
	var pathItemObject = {};
	verbs.type = verbs.type === "del" ? "delete" : verbs.type;

	var verbDefinitionResult = createVerbDefinitions(verbs, definitions);

	const parameters = createPathParameters(verbs);
	const parametersWithQueryMarked = parameters.map((parameter) => {
		if (!pathKeys.includes(parameter.name)) {
			parameter.in = 'query';
		}
		return parameter;
	});

	pathItemObject[verbs.type] = {
		tags: [verbs.group],
		summary: removeTags(verbs.description),
		consumes: [
			"application/json"
		],
		produces: [
			"application/json"
		],
		parameters: parametersWithQueryMarked
	}
	if (verbDefinitionResult.topLevelSuccessRef) {
		const match = verbDefinitionResult.topLevelSuccessRefType && verbDefinitionResult.topLevelSuccessRefType.match(/\w+(?=\[])/);
		pathItemObject[verbs.type].responses = {
          "200": {
            "description": "successful operation",
            "schema": {
              "type": match ? "array" : verbDefinitionResult.topLevelSuccessRefType,
              "items": {
                "$ref": "#/definitions/" + verbDefinitionResult.topLevelSuccessRef
              }
            }
          }
      	};
	}
	return pathItemObject;
}

/**
 * Iterate through all method parameters and create array of parameter objects which are stored as path parameters
 * @param verbs
 * @returns {Array}
 */
function createPathParameters(verbs) {
	var pathItemObject = [];
	if (verbs.parameter && verbs.parameter.fields.Parameter) {

		for (var i = 0; i < verbs.parameter.fields.Parameter.length; i++) {
			var param = verbs.parameter.fields.Parameter[i];
			var field = param.field;
			var type = param.type;

			let item = {
				name: field,
				in: type === "file" ? "formData" : "path",
				required: !param.optional,
				type: param.type.toLowerCase(),
				description: removeTags(param.description),
			};
			const match = type.match(/\w+(?=\[])/);
			if (match) {
				item.type = 'array';
				item.items = {type: match[0]};
			}
			pathItemObject.push(item);

		}
	}
	return pathItemObject;
}

function groupByUrl(apidocJson) {
	return _.chain(apidocJson)
		.groupBy("url")
		.toPairs()
		.map(function (element) {
			return _.zipObject(["url", "verbs"], element);
		})
		.value();
}

module.exports = {
	toSwagger: toSwagger
};