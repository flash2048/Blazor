// Copyright (c) .NET Foundation. All rights reserved.
// Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.

using System;

namespace Microsoft.AspNetCore.Blazor.Components
{
    [AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = true)]
    public sealed class BindInputElementAttribute : Attribute
    {
        public BindInputElementAttribute(string type, string suffix, string valueAttribute, string changeHandlerAttribute)
        {
            if (valueAttribute == null)
            {
                throw new ArgumentNullException(nameof(valueAttribute));
            }

            if (changeHandlerAttribute == null)
            {
                throw new ArgumentNullException(nameof(changeHandlerAttribute));
            }

            Type = type;
            Suffix = suffix;
            ValueAttribute = valueAttribute;
            ChangeHandlerAttribute = changeHandlerAttribute;
        }
        
        public string Type { get; }
        
        public string Suffix { get; }

        public string ValueAttribute { get; }

        public string ChangeHandlerAttribute { get; }
    }
}
