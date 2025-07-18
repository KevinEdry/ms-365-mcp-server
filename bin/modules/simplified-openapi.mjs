import fs from 'fs';
import yaml from 'js-yaml';

export function createAndSaveSimplifiedOpenAPI(endpointsFile, openapiFile, openapiTrimmedFile) {
  const endpoints = JSON.parse(fs.readFileSync(endpointsFile, 'utf8'));

  const spec = fs.readFileSync(openapiFile, 'utf8');
  const openApiSpec = yaml.load(spec);

  for (const endpoint of endpoints) {
    if (!openApiSpec.paths[endpoint.pathPattern]) {
      throw new Error(`Path "${endpoint.pathPattern}" not found in OpenAPI spec.`);
    }
  }

  for (const [key, value] of Object.entries(openApiSpec.paths)) {
    const e = endpoints.filter((ep) => ep.pathPattern === key);
    if (e.length === 0) {
      delete openApiSpec.paths[key];
    } else {
      for (const [method, operation] of Object.entries(value)) {
        const eo = e.find((ep) => ep.method.toLowerCase() === method);
        if (eo) {
          operation.operationId = eo.toolName;
        } else {
          delete value[method];
        }
      }
    }
  }

  if (openApiSpec.components && openApiSpec.components.schemas) {
    removeODataTypeRecursively(openApiSpec.components.schemas);
    flattenComplexSchemasRecursively(openApiSpec.components.schemas);
  }

  if (openApiSpec.paths) {
    removeODataTypeRecursively(openApiSpec.paths);
    simplifyAnyOfInPaths(openApiSpec.paths);
  }

  fs.writeFileSync(openapiTrimmedFile, yaml.dump(openApiSpec));
}

function removeODataTypeRecursively(obj) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach((item) => removeODataTypeRecursively(item));
    return;
  }

  if (obj.properties && obj.properties['@odata.type']) {
    delete obj.properties['@odata.type'];
  }

  if (obj.required && Array.isArray(obj.required)) {
    const typeIndex = obj.required.indexOf('@odata.type');
    if (typeIndex !== -1) {
      obj.required.splice(typeIndex, 1);
      if (obj.required.length === 0) {
        delete obj.required;
      }
    }
  }

  if (obj.properties) {
    removeODataTypeRecursively(obj.properties);
    Object.values(obj.properties).forEach((prop) => removeODataTypeRecursively(prop));
  }

  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    removeODataTypeRecursively(obj.additionalProperties);
  }

  if (obj.items) {
    removeODataTypeRecursively(obj.items);
  }

  ['allOf', 'anyOf', 'oneOf'].forEach((key) => {
    if (obj[key] && Array.isArray(obj[key])) {
      obj[key].forEach((item) => removeODataTypeRecursively(item));
    }
  });

  Object.keys(obj).forEach((key) => {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      removeODataTypeRecursively(obj[key]);
    }
  });
}

function flattenComplexSchemasRecursively(schemas) {
  console.log('Flattening complex schemas for better client compatibility...');

  let flattenedCount = 0;

  Object.keys(schemas).forEach((schemaName) => {
    const schema = schemas[schemaName];

    if (schema.allOf && Array.isArray(schema.allOf) && schema.allOf.length <= 5) {
      try {
        const flattened = { type: 'object', properties: {} };
        const required = new Set();

        for (const subSchema of schema.allOf) {
          if (subSchema.$ref && subSchema.$ref.startsWith('#/components/schemas/')) {
            const refName = subSchema.$ref.replace('#/components/schemas/', '');
            if (schemaName === 'microsoft.graph.attendee') {
              console.log(
                `Processing ref ${refName} for attendee, exists: ${!!schemas[refName]}, has properties: ${!!schemas[refName]?.properties}`
              );
              if (schemas[refName]?.properties) {
                console.log(`Properties in ${refName}:`, Object.keys(schemas[refName].properties));
              }
            }
            if (schemas[refName] && schemas[refName].properties) {
              Object.assign(flattened.properties, schemas[refName].properties);
              if (schemas[refName].required) {
                schemas[refName].required.forEach((req) => required.add(req));
              }
            }
          } else if (subSchema.properties) {
            Object.assign(flattened.properties, subSchema.properties);
            if (subSchema.required) {
              subSchema.required.forEach((req) => required.add(req));
            }
          }

          Object.keys(subSchema).forEach((key) => {
            if (!['allOf', 'properties', 'required', '$ref'].includes(key) && !flattened[key]) {
              flattened[key] = subSchema[key];
            }
          });
        }

        if (schema.properties) {
          Object.assign(flattened.properties, schema.properties);
        }

        if (schema.required) {
          schema.required.forEach((req) => required.add(req));
        }

        Object.keys(schema).forEach((key) => {
          if (!['allOf', 'properties', 'required'].includes(key) && !flattened[key]) {
            flattened[key] = schema[key];
          }
        });

        if (required.size > 0) {
          flattened.required = Array.from(required);
        }

        schemas[schemaName] = flattened;
        flattenedCount++;

        if (schemaName === 'microsoft.graph.attendee') {
          console.log('Ensuring attendee has all required properties from attendeeBase');
          const attendeeBase = schemas['microsoft.graph.attendeeBase'];
          if (attendeeBase && attendeeBase.properties) {
            if (!flattened.properties.emailAddress && attendeeBase.properties.emailAddress) {
              flattened.properties.emailAddress = attendeeBase.properties.emailAddress;
              console.log('Added emailAddress property to attendee');
            }
            if (!flattened.properties.type && attendeeBase.properties.type) {
              flattened.properties.type = attendeeBase.properties.type;
              console.log('Added type property to attendee');
            }
          }
        }
      } catch (error) {
        console.warn(`Warning: Could not flatten schema ${schemaName}:`, error.message);
      }
    }

    if (schema.anyOf && Array.isArray(schema.anyOf)) {
      if (schema.anyOf.length === 2) {
        const hasRef = schema.anyOf.some((item) => item.$ref);
        const hasNullableObject = schema.anyOf.some(
          (item) =>
            item.type === 'object' && item.nullable === true && Object.keys(item).length <= 2
        );

        if (hasRef && hasNullableObject) {
          console.log(`Simplifying anyOf in ${schemaName} (ref + nullable object pattern)`);
          const refItem = schema.anyOf.find((item) => item.$ref);
          const simplified = { ...refItem };
          simplified.nullable = true;
          Object.keys(schema).forEach((key) => {
            if (!['anyOf'].includes(key) && !simplified[key]) {
              simplified[key] = schema[key];
            }
          });
          schemas[schemaName] = simplified;
          flattenedCount++;
        }
      } else if (schema.anyOf.length > 2) {
        console.log(`Simplifying anyOf in ${schemaName} (${schema.anyOf.length} -> 1 option)`);
        const simplified = { ...schema.anyOf[0] };
        simplified.nullable = true;
        simplified.description = `Simplified from ${schema.anyOf.length} anyOf options`;
        schemas[schemaName] = simplified;
        flattenedCount++;
      }
    }

    if (schema.oneOf && Array.isArray(schema.oneOf) && schema.oneOf.length > 2) {
      console.log(`Simplifying oneOf in ${schemaName} (${schema.oneOf.length} -> 1 option)`);
      const simplified = { ...schema.oneOf[0] };
      simplified.nullable = true;
      simplified.description = `Simplified from ${schema.oneOf.length} oneOf options`;
      schemas[schemaName] = simplified;
      flattenedCount++;
    }

    if (schema.properties && Object.keys(schema.properties).length > 25) {
      console.log(
        `Reducing properties in ${schemaName} (${Object.keys(schema.properties).length} -> 25)`
      );
      const priorityProperties = {};
      const allKeys = Object.keys(schema.properties);

      if (schema.required) {
        schema.required.forEach((key) => {
          if (schema.properties[key]) {
            priorityProperties[key] = schema.properties[key];
          }
        });
      }

      const remainingSlots = 25 - Object.keys(priorityProperties).length;
      allKeys.slice(0, remainingSlots).forEach((key) => {
        if (!priorityProperties[key]) {
          priorityProperties[key] = schema.properties[key];
        }
      });

      schema.properties = priorityProperties;
      schema.description =
        `${schema.description || ''} [Simplified: showing ${Object.keys(priorityProperties).length} of ${allKeys.length} properties]`.trim();
      flattenedCount++;
    }

    if (schema.properties) {
      simplifyNestedPropertiesRecursively(schema.properties, 0, 4);
    }
  });

  Object.keys(schemas).forEach((schemaName) => {
    const schema = schemas[schemaName];
    if (schema.properties) {
      Object.keys(schema.properties).forEach((propName) => {
        const prop = schema.properties[propName];
        if (prop && prop.anyOf && Array.isArray(prop.anyOf) && prop.anyOf.length === 2) {
          const hasRef = prop.anyOf.some((item) => item.$ref);
          const hasNullableObject = prop.anyOf.some(
            (item) =>
              item.type === 'object' && item.nullable === true && Object.keys(item).length <= 2
          );

          if (hasRef && hasNullableObject) {
            console.log(
              `Simplifying anyOf in ${schemaName}.${propName} (ref + nullable object pattern)`
            );
            const refItem = prop.anyOf.find((item) => item.$ref);
            delete prop.anyOf;
            prop.$ref = refItem.$ref;
            prop.nullable = true;
            flattenedCount++;
          }
        }
      });
    }
  });

  console.log(`Flattened ${flattenedCount} complex schemas`);

  console.log('Second pass: Fixing inheritance dependencies...');
  if (schemas['microsoft.graph.attendee'] && schemas['microsoft.graph.attendeeBase']) {
    const attendee = schemas['microsoft.graph.attendee'];
    const attendeeBase = schemas['microsoft.graph.attendeeBase'];

    if (!attendee.properties.emailAddress && attendeeBase.properties?.emailAddress) {
      attendee.properties.emailAddress = attendeeBase.properties.emailAddress;
      console.log('Fixed: Added emailAddress to attendee from attendeeBase');
    }
    if (!attendee.properties.type && attendeeBase.properties?.type) {
      attendee.properties.type = attendeeBase.properties.type;
      console.log('Fixed: Added type to attendee from attendeeBase');
    }
  }
}

function simplifyAnyOfInPaths(paths) {
  console.log('Simplifying anyOf patterns in API paths...');
  let simplifiedCount = 0;

  Object.keys(paths).forEach((path) => {
    const pathItem = paths[path];
    Object.keys(pathItem).forEach((method) => {
      const operation = pathItem[method];
      if (operation && typeof operation === 'object') {
        if (operation.responses) {
          Object.keys(operation.responses).forEach((statusCode) => {
            const response = operation.responses[statusCode];
            if (response && response.content) {
              Object.keys(response.content).forEach((contentType) => {
                const mediaType = response.content[contentType];
                if (mediaType && mediaType.schema) {
                  simplifiedCount += simplifyAnyOfPattern(
                    mediaType.schema,
                    `${path}.${method}.${statusCode}`
                  );
                }
              });
            }
          });
        }

        if (operation.requestBody && operation.requestBody.content) {
          Object.keys(operation.requestBody.content).forEach((contentType) => {
            const mediaType = operation.requestBody.content[contentType];
            if (mediaType && mediaType.schema) {
              simplifiedCount += simplifyAnyOfPattern(
                mediaType.schema,
                `${path}.${method}.requestBody`
              );
            }
          });
        }
      }
    });
  });

  console.log(`Simplified ${simplifiedCount} anyOf patterns in paths`);
}

function simplifyAnyOfPattern(obj, context = '') {
  let count = 0;

  if (!obj || typeof obj !== 'object') return count;

  if (obj.anyOf && Array.isArray(obj.anyOf) && obj.anyOf.length === 2) {
    const hasRef = obj.anyOf.some((item) => item.$ref);
    const hasNullableObject = obj.anyOf.some(
      (item) => item.type === 'object' && item.nullable === true && Object.keys(item).length <= 2
    );

    if (hasRef && hasNullableObject) {
      console.log(`Simplifying anyOf in ${context} (ref + nullable object pattern)`);
      const refItem = obj.anyOf.find((item) => item.$ref);
      Object.keys(obj).forEach((key) => {
        if (key !== 'anyOf') delete obj[key];
      });
      Object.assign(obj, refItem);
      obj.nullable = true;
      delete obj.anyOf;
      count++;
    }
  }

  Object.keys(obj).forEach((key) => {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      count += simplifyAnyOfPattern(obj[key], context ? `${context}.${key}` : key);
    }
  });

  return count;
}

function simplifyNestedPropertiesRecursively(properties, currentDepth, maxDepth) {
  if (currentDepth >= maxDepth) {
    return;
  }

  Object.keys(properties).forEach((key) => {
    const prop = properties[key];

    if (prop && typeof prop === 'object') {
      if (currentDepth === maxDepth - 1 && prop.properties) {
        console.log(`Flattening nested property at depth ${currentDepth}: ${key}`);
        prop.type = 'object';
        prop.description = `${prop.description || ''} [Simplified: nested object]`.trim();
        delete prop.properties;
        delete prop.additionalProperties;
      } else if (prop.properties) {
        simplifyNestedPropertiesRecursively(prop.properties, currentDepth + 1, maxDepth);
      }

      if (prop.anyOf && Array.isArray(prop.anyOf)) {
        if (prop.anyOf.length === 2) {
          const hasRef = prop.anyOf.some((item) => item.$ref);
          const hasNullableObject = prop.anyOf.some(
            (item) =>
              item.type === 'object' && item.nullable === true && Object.keys(item).length <= 2
          );

          if (hasRef && hasNullableObject) {
            console.log(`Simplifying anyOf in property ${key} (ref + nullable object pattern)`);
            const refItem = prop.anyOf.find((item) => item.$ref);
            delete prop.anyOf;
            prop.$ref = refItem.$ref;
            prop.nullable = true;
          }
        } else if (prop.anyOf.length > 2) {
          prop.type = prop.anyOf[0].type || 'object';
          prop.nullable = true;
          prop.description =
            `${prop.description || ''} [Simplified from ${prop.anyOf.length} options]`.trim();
          delete prop.anyOf;
        }
      }

      if (prop.oneOf && Array.isArray(prop.oneOf) && prop.oneOf.length > 2) {
        prop.type = prop.oneOf[0].type || 'object';
        prop.nullable = true;
        prop.description =
          `${prop.description || ''} [Simplified from ${prop.oneOf.length} options]`.trim();
        delete prop.oneOf;
      }
    }
  });
}
